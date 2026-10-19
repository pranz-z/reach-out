<?php

namespace App\Services\Agent\Tools;

use App\Models\Lead;
use App\Models\Suppression;

/**
 * Lets the agent pick up leads that are already saved (for example from a CSV import)
 * and have a public email but no first email yet. Read-only.
 */
class ListDraftableLeadsTool extends Tool
{
    public function name(): string
    {
        return 'list_draftable_leads';
    }

    public function description(): string
    {
        return 'List already-saved leads that have a public business email and no first email drafted yet (for example imported from CSV). Read-only. Use it to draft emails for leads that are already in the database.';
    }

    public function parameters(): array
    {
        return ['type' => 'object', 'properties' => new \stdClass()];
    }

    public function execute(array $args): array
    {
        $leads = Lead::where('status', 'enriched')
            ->whereNotNull('public_email')
            ->whereDoesntHave('drafts', fn ($q) => $q->where('kind', 'first'))
            ->orderBy('id')
            ->limit(10)
            ->get()
            ->reject(fn (Lead $l) => Suppression::blocks($l->public_email))
            ->map(fn (Lead $l) => [
                'lead_id' => $l->id,
                'name' => $l->name,
                'category' => $l->category,
                'city' => $l->city,
                'website_url' => $l->website_url,
                'website_status' => $l->website_status,
                'signals' => $l->signals,
                'facebook_url' => $l->facebook_url,
                'facebook_confidence' => $l->facebook_confidence,
                'has_public_email' => true,
            ])
            ->values()
            ->all();

        return ['ok' => true, 'count' => count($leads), 'leads' => $leads];
    }
}
