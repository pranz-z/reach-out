<?php

namespace App\Console\Commands;

use App\Models\SearchProfile;
use App\Services\Agent\AgentRunner;
use Illuminate\Console\Command;

class RunAgent extends Command
{
    protected $signature = 'reachout:run {profile : Search profile id or name}';

    protected $description = 'Run the lead-research agent for one search profile and queue drafts for review';

    public function handle(AgentRunner $runner): int
    {
        $key = $this->argument('profile');
        $profile = SearchProfile::where('active', true)
            ->where(fn ($q) => $q->where('id', $key)->orWhere('name', $key))
            ->first();

        if (! $profile) {
            $this->error("No active search profile matches '{$key}'.");

            return self::FAILURE;
        }

        $this->info("Running agent for profile: {$profile->name} (model: ".config('reachout.llm.model').')');
        $run = $runner->run($profile);

        $this->line("Status: {$run->status} | steps: {$run->steps_used} | leads saved: {$run->leads_saved} | drafts queued: {$run->drafts_queued}");
        if ($run->error) {
            $this->warn($run->error);
        }
        $this->line('Review drafts in the dashboard: /review');

        return $run->status === 'failed' ? self::FAILURE : self::SUCCESS;
    }
}
