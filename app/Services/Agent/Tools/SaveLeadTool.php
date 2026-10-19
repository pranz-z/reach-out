<?php

namespace App\Services\Agent\Tools;

use App\Models\AuditLog;
use App\Models\Lead;
use App\Models\Suppression;
use App\Services\Support\SafeFetcher;

class SaveLeadTool extends Tool
{
    private const STATUSES = ['none', 'social_only', 'basic', 'modern', 'unknown'];

    public function name(): string
    {
        return 'save_lead';
    }

    public function description(): string
    {
        return 'Save or update a lead with the facts collected so far. Only these fields are stored. Duplicate place_ids update the existing lead. Returns lead_id.';
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'place_id' => ['type' => 'string'],
                'name' => ['type' => 'string'],
                'category' => ['type' => 'string'],
                'address' => ['type' => 'string'],
                'city' => ['type' => 'string'],
                'phone' => ['type' => 'string'],
                'website_url' => ['type' => 'string'],
                'website_status' => ['type' => 'string', 'enum' => self::STATUSES],
                'signals' => ['type' => 'object'],
                'facebook_url' => ['type' => 'string'],
                'facebook_confidence' => ['type' => 'string', 'enum' => ['none', 'unverified', 'likely']],
                'public_email' => ['type' => 'string'],
                'fit_score' => ['type' => 'string', 'enum' => ['high', 'medium', 'low']],
            ],
            'required' => ['name', 'city'],
        ];
    }

    public function execute(array $args): array
    {
        if ($this->run->leads_saved >= config('reachout.agent.max_leads_per_run')) {
            return $this->error('Lead cap for this run reached. Stop and finish.');
        }

        $name = trim((string) ($args['name'] ?? ''));
        $city = trim((string) ($args['city'] ?? ''));
        if ($name === '' || $city === '') {
            return $this->error('name and city are required');
        }
        if (! in_array(mb_strtolower($city), array_map('mb_strtolower', $this->profile->cities), true)) {
            return $this->error('city is not in this profile');
        }

        $email = isset($args['public_email']) ? strtolower(trim((string) $args['public_email'])) : null;
        if ($email !== null && $email !== '') {
            if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
                return $this->error('public_email is not a valid address');
            }
            if (Suppression::blocks($email)) {
                return $this->error('That email is on the suppression list. Do not save it.');
            }
        } else {
            $email = null;
        }

        $facebook = $args['facebook_url'] ?? null;
        if ($facebook && ! preg_match('#^https://([a-z]+\.)?facebook\.com/#i', $facebook)) {
            $facebook = null; // only accept facebook.com links, URL only
        }

        $website = $args['website_url'] ?? null;
        $websiteStatus = in_array($args['website_status'] ?? '', self::STATUSES, true) ? $args['website_status'] : 'unknown';
        if ($website && SafeFetcher::isSocial($website)) {
            $websiteStatus = 'social_only';
        }

        $attributes = [
            'profile_id' => $this->profile->id,
            'name' => $name,
            'category' => $args['category'] ?? null,
            'address' => $args['address'] ?? null,
            'city' => $city,
            'phone' => $args['phone'] ?? null,
            'website_url' => $website ?: null,
            'website_status' => $websiteStatus,
            'signals' => is_array($args['signals'] ?? null) ? $args['signals'] : null,
            'facebook_url' => $facebook,
            'facebook_confidence' => $facebook ? ($args['facebook_confidence'] ?? 'unverified') : 'none',
            'public_email' => $email,
            'email_source' => $email ? 'website' : null,
            'fit_score' => in_array($args['fit_score'] ?? '', ['high', 'medium', 'low'], true) ? $args['fit_score'] : null,
            'status' => $email ? 'enriched' : 'phone_only',
        ];

        $placeId = $args['place_id'] ?? null;
        $lead = $placeId ? Lead::where('place_id', $placeId)->first() : null;
        $isNew = $lead === null;

        if ($lead) {
            // Never let the agent resurrect or alter a lead that has moved past enrichment.
            if (! in_array($lead->status, ['new', 'enriched', 'phone_only'], true)) {
                return ['ok' => true, 'lead_id' => $lead->id, 'note' => 'lead already past enrichment; unchanged'];
            }
            $lead->update($attributes);
        } else {
            $lead = Lead::create($attributes + ['place_id' => $placeId]);
            $this->run->increment('leads_saved');
        }

        AuditLog::record('lead', $lead->id, $isNew ? 'created' : 'updated', ['by' => 'agent', 'run_id' => $this->run->id]);

        return ['ok' => true, 'lead_id' => $lead->id, 'status' => $lead->status];
    }
}
