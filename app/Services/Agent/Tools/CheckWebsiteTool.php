<?php

namespace App\Services\Agent\Tools;

use App\Services\Support\SafeFetcher;

class CheckWebsiteTool extends Tool
{
    public function name(): string
    {
        return 'check_website';
    }

    public function description(): string
    {
        return "Classify a business's website from its URL: none, social_only, basic or modern, plus simple signals (https, mobile viewport, online ordering/booking, copyright year). Pass an empty url if the business lists no website.";
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'url' => ['type' => 'string', 'description' => 'Website URL, or empty string if none is listed.'],
            ],
            'required' => ['url'],
        ];
    }

    public function execute(array $args): array
    {
        $url = trim((string) ($args['url'] ?? ''));

        if ($url === '') {
            return ['ok' => true, 'website_status' => 'none', 'signals' => []];
        }
        if (SafeFetcher::isSocial($url)) {
            return ['ok' => true, 'website_status' => 'social_only', 'signals' => ['social_page_only' => true]];
        }

        $page = SafeFetcher::get($url);
        if (! $page['ok']) {
            // Robots/private-address blocks are not "site is down": report the reason.
            $blocked = in_array($page['error'], ['disallowed_by_robots_txt', 'blocked_private_address', 'invalid_url'], true);

            return [
                'ok' => true,
                'website_status' => $blocked ? 'unknown' : 'social_only',
                'signals' => ['fetch_error' => $page['error']],
            ];
        }

        $html = $page['body'];
        $signals = [
            'https' => str_starts_with(strtolower($url), 'https://'),
            'mobile_viewport' => (bool) preg_match('/<meta[^>]+name=["\']viewport["\']/i', $html),
            'online_ordering_or_booking' => (bool) preg_match('/order online|add to cart|book (now|online|an appointment)|reserve a table|checkout/i', $html),
            'latest_year_seen' => null,
        ];
        if (preg_match_all('/(?:©|&copy;|copyright)[^0-9]{0,20}((?:19|20)\d{2})/i', $html, $m)) {
            $signals['latest_year_seen'] = (int) max($m[1]);
        }

        $score = (int) $signals['https'] + (int) $signals['mobile_viewport'] + (int) $signals['online_ordering_or_booking']
            + (($signals['latest_year_seen'] ?? 0) >= ((int) date('Y')) - 1 ? 1 : 0);

        return [
            'ok' => true,
            'website_status' => $score >= 3 ? 'modern' : 'basic',
            'signals' => $signals,
        ];
    }
}
