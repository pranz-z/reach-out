<?php

namespace App\Services\Support;

use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * Fetches a business's OWN public website, politely:
 *  - http/https only
 *  - refuses hosts that resolve to private/reserved IP ranges
 *  - respects robots.txt
 *  - never used for facebook.com or other social platforms
 */
class SafeFetcher
{
    private const BLOCKED_HOSTS = ['facebook.com', 'fb.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com'];

    public static function isSocial(?string $url): bool
    {
        $host = self::host($url);
        if ($host === null) {
            return false;
        }
        foreach (self::BLOCKED_HOSTS as $blocked) {
            if ($host === $blocked || str_ends_with($host, '.'.$blocked)) {
                return true;
            }
        }

        return false;
    }

    public static function host(?string $url): ?string
    {
        if (! $url) {
            return null;
        }
        $host = parse_url($url, PHP_URL_HOST);

        return $host ? strtolower(preg_replace('/^www\./i', '', $host)) : null;
    }

    /**
     * @return array{ok:bool, status?:int, body?:string, error?:string, final_url?:string}
     */
    public static function get(string $url): array
    {
        $parts = parse_url($url);
        if (! $parts || ! in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host'])) {
            return ['ok' => false, 'error' => 'invalid_url'];
        }
        if (self::isSocial($url)) {
            return ['ok' => false, 'error' => 'social_platform_not_fetched'];
        }
        if (! self::publicHost($parts['host'])) {
            return ['ok' => false, 'error' => 'blocked_private_address'];
        }
        if (! self::allowedByRobots($parts)) {
            return ['ok' => false, 'error' => 'disallowed_by_robots_txt'];
        }

        try {
            $response = Http::withUserAgent(config('reachout.http.user_agent'))
                ->timeout(config('reachout.http.timeout'))
                ->withOptions(['allow_redirects' => ['max' => 3, 'protocols' => ['http', 'https']]])
                ->get($url);
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => 'fetch_failed'];
        }

        if ($response->failed()) {
            return ['ok' => false, 'status' => $response->status(), 'error' => 'http_'.$response->status()];
        }

        // Cap the body so a huge page can't blow up memory.
        return ['ok' => true, 'status' => $response->status(), 'body' => substr($response->body(), 0, 400000)];
    }

    private static function publicHost(string $host): bool
    {
        $ip = filter_var($host, FILTER_VALIDATE_IP) ? $host : gethostbyname($host);
        if ($ip === $host && ! filter_var($host, FILTER_VALIDATE_IP)) {
            return false; // did not resolve
        }

        return (bool) filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    }

    /** Minimal robots.txt check for the "*" user-agent. Unreachable robots.txt = allowed. */
    private static function allowedByRobots(array $parts): bool
    {
        $origin = $parts['scheme'].'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');
        $path = ($parts['path'] ?? '/') ?: '/';

        try {
            $response = Http::withUserAgent(config('reachout.http.user_agent'))
                ->timeout(5)->get($origin.'/robots.txt');
        } catch (Throwable $e) {
            return true;
        }
        if (! $response->successful()) {
            return true;
        }

        $applies = false;
        foreach (preg_split('/\r?\n/', $response->body()) as $line) {
            $line = trim(preg_replace('/#.*/', '', $line));
            if ($line === '' || ! str_contains($line, ':')) {
                continue;
            }
            [$key, $value] = array_map('trim', explode(':', $line, 2));
            $key = strtolower($key);
            if ($key === 'user-agent') {
                $applies = ($value === '*');
            } elseif ($applies && $key === 'disallow' && $value !== '' && str_starts_with($path, $value)) {
                return false;
            }
        }

        return true;
    }
}
