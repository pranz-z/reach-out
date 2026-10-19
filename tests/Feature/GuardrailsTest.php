<?php

namespace Tests\Feature;

use App\Models\AgentRun;
use App\Models\Lead;
use App\Models\SearchProfile;
use App\Models\Suppression;
use App\Services\Agent\Tools\QueueDraftTool;
use App\Services\Agent\Tools\SaveLeadTool;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class GuardrailsTest extends TestCase
{
    use RefreshDatabase;

    private function setupProfile(): array
    {
        config([
            'reachout.sender_name' => 'Franz',
            'reachout.portfolio_url' => 'https://example.com/portfolio',
        ]);
        $profile = SearchProfile::create(['name' => 'Test', 'categories' => ['cafe'], 'cities' => ['Guagua']]);
        $run = AgentRun::create(['profile_id' => $profile->id, 'status' => 'running']);

        return [$profile, $run];
    }

    private function goodBody(): string
    {
        return "Hi team,\n\nI noticed you have no website. I build POS systems with an AI assistant.\n\nPortfolio: https://example.com/portfolio\n\nIf it's not relevant, just reply STOP and I won't email again.\n\nFranz";
    }

    public function test_draft_without_opt_out_line_is_rejected(): void
    {
        [$profile, $run] = $this->setupProfile();
        $lead = Lead::create(['name' => 'Cafe A', 'city' => 'Guagua', 'public_email' => 'info@cafea.test', 'status' => 'enriched']);

        $result = (new QueueDraftTool($profile, $run))->execute([
            'lead_id' => $lead->id, 'subject' => 'Hello', 'body' => 'Hi, buy my POS. Franz https://example.com/portfolio',
            'suggestion' => 'POS', 'found' => ['no website'],
        ]);

        $this->assertFalse($result['ok']);
        $this->assertDatabaseCount('drafts', 0);
    }

    public function test_valid_draft_is_queued_as_pending_only(): void
    {
        [$profile, $run] = $this->setupProfile();
        $lead = Lead::create(['name' => 'Cafe A', 'city' => 'Guagua', 'public_email' => 'info@cafea.test', 'status' => 'enriched']);

        $result = (new QueueDraftTool($profile, $run))->execute([
            'lead_id' => $lead->id, 'subject' => 'Hello', 'body' => $this->goodBody(),
            'suggestion' => 'POS with stock alerts', 'found' => ['no website listed'],
        ]);

        $this->assertTrue($result['ok']);
        $this->assertDatabaseHas('drafts', ['lead_id' => $lead->id, 'status' => 'pending']);
    }

    public function test_suppressed_email_cannot_be_drafted_or_saved(): void
    {
        [$profile, $run] = $this->setupProfile();
        Suppression::add('info@cafea.test');

        $save = (new SaveLeadTool($profile, $run))->execute(['name' => 'Cafe A', 'city' => 'Guagua', 'public_email' => 'info@cafea.test']);
        $this->assertFalse($save['ok']);

        $lead = Lead::create(['name' => 'Cafe B', 'city' => 'Guagua', 'public_email' => 'other@cafea.test', 'status' => 'enriched']);
        $draft = (new QueueDraftTool($profile, $run))->execute([
            'lead_id' => $lead->id, 'subject' => 'Hello', 'body' => $this->goodBody(), 'suggestion' => 'POS', 'found' => ['x'],
        ]);
        $this->assertFalse($draft['ok'], 'domain-level suppression must block other addresses on the same domain');
    }

    public function test_leads_outside_the_profile_cities_are_refused(): void
    {
        [$profile, $run] = $this->setupProfile();

        $result = (new SaveLeadTool($profile, $run))->execute(['name' => 'Cafe C', 'city' => 'Singapore']);

        $this->assertFalse($result['ok']);
    }

    public function test_only_one_first_email_per_lead(): void
    {
        [$profile, $run] = $this->setupProfile();
        $lead = Lead::create(['name' => 'Cafe A', 'city' => 'Guagua', 'public_email' => 'info@cafea.test', 'status' => 'enriched']);
        $args = ['lead_id' => $lead->id, 'subject' => 'Hello', 'body' => $this->goodBody(), 'suggestion' => 'POS', 'found' => ['x']];

        $this->assertTrue((new QueueDraftTool($profile, $run))->execute($args)['ok']);
        $this->assertFalse((new QueueDraftTool($profile, $run))->execute($args)['ok']);
    }
}
