<?php

namespace App\Services\Agent\Tools;

use App\Models\AuditLog;
use App\Models\Draft;
use App\Models\Lead;
use App\Models\Suppression;

/**
 * The ONLY way the agent can produce an email, and it only ever creates a
 * PENDING draft for human review. There is no send tool.
 */
class QueueDraftTool extends Tool
{
    public function name(): string
    {
        return 'queue_draft_for_review';
    }

    public function description(): string
    {
        return 'Queue a cold proposal email draft for human review. Requires a saved lead with a public business email. The body must be plain text, under the word limit, include the sender name and portfolio link, and contain the opt-out line ("reply STOP"). Only state facts that were actually collected.';
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'lead_id' => ['type' => 'integer'],
                'subject' => ['type' => 'string'],
                'body' => ['type' => 'string'],
                'suggestion' => ['type' => 'string', 'description' => 'Suggested system and one-line reasoning, for the reviewer.'],
                'found' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Facts actually collected about this business, for the reviewer.'],
            ],
            'required' => ['lead_id', 'subject', 'body', 'suggestion', 'found'],
        ];
    }

    public function execute(array $args): array
    {
        $lead = Lead::find((int) ($args['lead_id'] ?? 0));
        if (! $lead) {
            return $this->error('Unknown lead_id. Call save_lead first.');
        }
        if (! $lead->public_email) {
            return $this->error('Lead has no public business email. Do not draft an email for it.');
        }
        if (Suppression::blocks($lead->public_email)) {
            return $this->error('Lead email is on the suppression list.');
        }
        if (! in_array($lead->status, ['enriched', 'drafted'], true)) {
            return $this->error("Lead status is '{$lead->status}', so it cannot receive a new draft.");
        }
        if ($lead->drafts()->where('kind', 'first')->whereIn('status', ['pending', 'approved', 'sent'])->exists()) {
            return $this->error('This lead already has a first email. Only one first email per business.');
        }

        $subject = trim((string) ($args['subject'] ?? ''));
        $body = trim((string) ($args['body'] ?? ''));
        if ($subject === '' || mb_strlen($subject) > 120) {
            return $this->error('subject is required and must be under 120 characters.');
        }

        // Guardrail: opt-out line, sender identity, portfolio link, length.
        $marker = config('reachout.required_opt_out_marker');
        if (! preg_match('/reply\s+"?'.preg_quote($marker, '/').'"?/i', $body)) {
            return $this->error("Body must include an opt-out line like: If it's not relevant, just reply {$marker} and I won't email again.");
        }
        if (stripos($body, config('reachout.sender_name')) === false) {
            return $this->error('Body must be signed with the sender name: '.config('reachout.sender_name'));
        }
        if (stripos($body, config('reachout.portfolio_url')) === false) {
            return $this->error('Body must include the portfolio link: '.config('reachout.portfolio_url'));
        }
        if (str_word_count($body) > config('reachout.max_email_words')) {
            return $this->error('Body is too long. Keep it under '.config('reachout.max_email_words').' words.');
        }
        if (preg_match('/<[a-z][^>]*>/i', $body)) {
            return $this->error('Body must be plain text, no HTML.');
        }

        $found = array_values(array_filter(array_map('strval', (array) ($args['found'] ?? []))));
        $draft = Draft::create([
            'lead_id' => $lead->id,
            'kind' => 'first',
            'subject' => $subject,
            'body' => $body,
            'suggestion' => trim((string) ($args['suggestion'] ?? '')),
            'found' => $found,
            'status' => 'pending',
            'model' => config('reachout.llm.model'),
        ]);
        $lead->update(['status' => 'drafted']);
        $this->run->increment('drafts_queued');

        AuditLog::record('draft', $draft->id, 'queued', ['by' => 'agent', 'run_id' => $this->run->id, 'lead_id' => $lead->id]);

        return ['ok' => true, 'draft_id' => $draft->id, 'status' => 'pending'];
    }
}
