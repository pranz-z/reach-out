<?php

namespace App\Services\Agent\Tools;

use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * Finds a likely Facebook page URL through an OFFICIAL search API.
 * It never fetches facebook.com and never reads page content; it only
 * returns a link for the human reviewer to open.
 */
class FindFacebookLinkTool extends Tool
{
    public function name(): string
    {
        return 'find_facebook_link';
    }

    public function description(): string
    {
        return 'Look up a business name in a web search API and return a facebook.com page URL if one matches. Returns URL only, labelled unverified or likely. The page itself is never opened.';
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'name' => ['type' => 'string'],
                'city' => ['type' => 'string'],
            ],
            'required' => ['name', 'city'],
        ];
    }

    public function execute(array $args): array
    {
        $name = trim((string) ($args['name'] ?? ''));
        $city = trim((string) ($args['city'] ?? ''));
        if ($name === '') {
            return $this->error('name is required');
        }

        $query = "\"{$name}\" {$city} facebook";
        try {
            $items = config('reachout.search.provider') === 'google'
                ? $this->searchGoogle($query)
                : $this->searchBrave($query);
        } catch (Throwable $e) {
            return $this->error('Search request failed.');
        }
        if ($items === null) {
            return $this->error('Search API is not configured (SEARCH_API_KEY).');
        }

        $nameTokens = array_filter(preg_split('/\W+/u', mb_strtolower($name)), fn ($t) => mb_strlen($t) > 2);

        foreach ($items as $item) {
            $host = strtolower((string) parse_url($item['url'], PHP_URL_HOST));
            if (! in_array(preg_replace('/^(www|m|web)\./', '', $host), ['facebook.com'], true)) {
                continue;
            }
            $haystack = mb_strtolower($item['title'].' '.$item['snippet']);
            $matched = count(array_filter($nameTokens, fn ($t) => str_contains($haystack, $t)));
            if ($nameTokens === [] || $matched === 0) {
                continue;
            }
            $allTokens = $matched === count($nameTokens);
            $cityHit = $city !== '' && str_contains($haystack, mb_strtolower($city));

            return [
                'ok' => true,
                'facebook_url' => $item['url'],
                'facebook_confidence' => ($allTokens && $cityHit) ? 'likely' : 'unverified',
            ];
        }

        return ['ok' => true, 'facebook_url' => null, 'facebook_confidence' => 'none'];
    }

    /** @return array<int,array{url:string,title:string,snippet:string}>|null */
    private function searchBrave(string $query): ?array
    {
        $key = config('reachout.search.api_key');
        if (! $key) {
            return null;
        }
        $res = Http::withHeaders(['X-Subscription-Token' => $key, 'Accept' => 'application/json'])
            ->timeout(10)
            ->get('https://api.search.brave.com/res/v1/web/search', ['q' => $query, 'count' => 10, 'country' => 'PH']);

        return collect($res->json('web.results', []))->map(fn ($r) => [
            'url' => $r['url'] ?? '',
            'title' => $r['title'] ?? '',
            'snippet' => $r['description'] ?? '',
        ])->all();
    }

    /** @return array<int,array{url:string,title:string,snippet:string}>|null */
    private function searchGoogle(string $query): ?array
    {
        $key = config('reachout.search.api_key');
        $cx = config('reachout.search.engine_id');
        if (! $key || ! $cx) {
            return null;
        }
        $res = Http::timeout(10)->get('https://www.googleapis.com/customsearch/v1', [
            'key' => $key, 'cx' => $cx, 'q' => $query, 'num' => 10, 'gl' => 'ph',
        ]);

        return collect($res->json('items', []))->map(fn ($r) => [
            'url' => $r['link'] ?? '',
            'title' => $r['title'] ?? '',
            'snippet' => $r['snippet'] ?? '',
        ])->all();
    }
}
