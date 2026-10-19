<?php

namespace App\Services\Agent;

use App\Models\AgentRun;
use App\Models\AgentStep;
use App\Models\SearchProfile;
use App\Services\Agent\Tools\CheckSuppressionTool;
use App\Services\Agent\Tools\CheckWebsiteTool;
use App\Services\Agent\Tools\FindFacebookLinkTool;
use App\Services\Agent\Tools\FindPublicEmailTool;
use App\Services\Agent\Tools\ListDraftableLeadsTool;
use App\Services\Agent\Tools\QueueDraftTool;
use App\Services\Agent\Tools\SaveLeadTool;
use App\Services\Agent\Tools\SearchPlacesTool;
use App\Services\Agent\Tools\Tool;
use App\Services\Llm\LlmClient;
use Throwable;

/**
 * The harness: model + tools + loop.
 * Limits (steps, per-tool caps, lead cap) are enforced here and in the tools.
 * There is deliberately no send tool.
 */
class AgentRunner
{
    public function __construct(private LlmClient $llm)
    {
    }

    public function run(SearchProfile $profile): AgentRun
    {
        $run = AgentRun::create([
            'profile_id' => $profile->id,
            'status' => 'running',
            'model' => $this->llm->model(),
            'started_at' => now(),
        ]);

        /** @var array<string,Tool> $tools */
        $tools = [];
        foreach ([
            SearchPlacesTool::class, CheckWebsiteTool::class, FindFacebookLinkTool::class,
            FindPublicEmailTool::class, CheckSuppressionTool::class, SaveLeadTool::class, QueueDraftTool::class,
            ListDraftableLeadsTool::class,
        ] as $class) {
            $tool = new $class($profile, $run);
            $tools[$tool->name()] = $tool;
        }
        $schemas = array_map(fn (Tool $t) => $t->schema(), array_values($tools));

        $messages = [
            ['role' => 'system', 'content' => $this->systemPrompt()],
            ['role' => 'user', 'content' => $this->goal($profile)],
        ];

        $maxSteps = config('reachout.agent.max_steps');
        $caps = config('reachout.agent.tool_call_caps');
        $calls = [];
        $step = 0;

        try {
            while ($step < $maxSteps) {
                $step++;
                $reply = $this->llm->chat($messages, $schemas);
                $this->log($run, $step, 'assistant', null, null, ['content' => $reply['content'] ?? null, 'tool_calls' => $reply['tool_calls'] ?? null]);
                $messages[] = $this->cleanAssistant($reply);

                $toolCalls = $reply['tool_calls'] ?? [];
                if ($toolCalls === []) {
                    $run->update(['status' => 'finished']);
                    break;
                }

                foreach ($toolCalls as $call) {
                    $name = $call['function']['name'] ?? '';
                    $args = json_decode($call['function']['arguments'] ?? '{}', true);
                    $args = is_array($args) ? $args : [];

                    if (! isset($tools[$name])) {
                        $result = ['ok' => false, 'error' => "Unknown tool '{$name}'."];
                    } elseif (($calls[$name] = ($calls[$name] ?? 0) + 1) > ($caps[$name] ?? PHP_INT_MAX)) {
                        $result = ['ok' => false, 'error' => "Call limit for {$name} reached in this run."];
                    } else {
                        try {
                            $result = $tools[$name]->execute($args);
                        } catch (Throwable $e) {
                            $result = ['ok' => false, 'error' => 'Tool crashed: '.class_basename($e)];
                        }
                    }

                    $this->log($run, $step, 'tool', $name, $args, $result);
                    $messages[] = [
                        'role' => 'tool',
                        'tool_call_id' => $call['id'] ?? $name,
                        'content' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                    ];
                }

                $run->refresh();
                if ($run->leads_saved >= config('reachout.agent.max_leads_per_run') && $run->drafts_queued >= $run->leads_saved) {
                    $run->update(['status' => 'finished']);
                    break;
                }
            }

            $run->refresh();
            if ($run->status === 'running') {
                $run->update(['status' => 'stopped', 'error' => 'Step limit reached.']);
            }
        } catch (Throwable $e) {
            $run->update(['status' => 'failed', 'error' => substr($e->getMessage(), 0, 500)]);
        }

        $run->update(['steps_used' => $step, 'finished_at' => now()]);

        return $run->fresh();
    }

    private function systemPrompt(): string
    {
        $sender = config('reachout.sender_name');
        $portfolio = config('reachout.portfolio_url');
        $marker = config('reachout.required_opt_out_marker');
        $words = config('reachout.max_email_words');

        return <<<PROMPT
You are a lead-research assistant for {$sender}, a freelance developer in the Philippines who builds POS systems with AI assistants and other business software.

Your job: find local businesses, check what they publicly have online, and queue a short, honest cold proposal email for HUMAN review. You cannot send email.

First call list_draftable_leads: those leads are already saved (for example imported by the owner) and only need a draft. Draft them with queue_draft_for_review using only the facts returned, then move on to discovery.

Workflow per newly discovered business:
1. search_places for a category and city from the profile.
2. check_website on its website_url (empty string if none).
3. If the business has no real own website, find_facebook_link (it returns a URL only, never open it).
4. find_public_email on its own website if it has one. Never guess an email address.
5. save_lead with ONLY facts you actually collected. Set fit_score from what you found.
6. If the lead has a public email, queue_draft_for_review.

Rules:
- Only state facts present in tool results. Never invent details about a business.
- Skip businesses that already have a modern website with online ordering or booking, or that have no public email (save them as phone-only and move on).
- Tentative tone ("I noticed...", "would this be useful?"), plain text, under {$words} words, one concrete offer.
- Every email must be signed "{$sender}", include {$portfolio}, and include an opt-out line such as: If it's not relevant, just reply {$marker} and I won't email again.
- queue_draft_for_review's "found" list must contain only facts from tool results; "suggestion" is the system you recommend and why in one line.
- When you have processed enough leads or tools report a limit, stop calling tools and give a one-paragraph summary.
PROMPT;
    }

    private function goal(SearchProfile $profile): string
    {
        $cap = config('reachout.agent.max_leads_per_run');

        return 'Profile "'.$profile->name.'". Categories: '.implode(', ', $profile->categories)
            .'. Cities: '.implode(', ', $profile->cities)
            .". Find up to {$cap} good-fit leads in total and queue drafts for review.";
    }

    /** Keep only the fields the API expects when echoing the assistant message back. */
    private function cleanAssistant(array $reply): array
    {
        $msg = ['role' => 'assistant', 'content' => $reply['content'] ?? ''];
        if (! empty($reply['tool_calls'])) {
            $msg['tool_calls'] = $reply['tool_calls'];
        }

        return $msg;
    }

    private function log(AgentRun $run, int $step, string $role, ?string $tool, ?array $args, ?array $result): void
    {
        AgentStep::create([
            'run_id' => $run->id,
            'step' => $step,
            'role' => $role,
            'tool' => $tool,
            'arguments' => $args,
            'result' => $result,
        ]);
    }
}
