<?php

namespace App\Services\Agent\Tools;

use App\Models\Suppression;
use App\Services\Support\SafeFetcher;

/**
 * Reads the business's OWN website (homepage + common contact pages) for an
 * email address the business publishes. It never guesses addresses.
 */
class FindPublicEmailTool extends Tool
{
    private const PATHS = ['', '/contact', '/contact-us', '/about', '/about-us'];

    public function name(): string
    {
        return 'find_public_email';
    }

    public function description(): string
    {
        return "Find a business email address that the business itself publishes on its own website's home or contact pages. Returns null if none is published. Never guesses addresses.";
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'website_url' => ['type' => 'string', 'description' => "The business's own website URL (not a social media page)."],
            ],
            'required' => ['website_url'],
        ];
    }

    public function execute(array $args): array
    {
        $url = trim((string) ($args['website_url'] ?? ''));
        if ($url === '' || SafeFetcher::isSocial($url)) {
            return ['ok' => true, 'public_email' => null, 'reason' => 'no_own_website'];
        }

        $parts = parse_url($url);
        if (! $parts || empty($parts['scheme']) || empty($parts['host'])) {
            return $this->error('invalid url');
        }
        $origin = $parts['scheme'].'://'.$parts['host'];
        $siteDomain = SafeFetcher::host($url);

        $found = [];
        foreach (self::PATHS as $path) {
            $page = SafeFetcher::get($origin.$path);
            if (! $page['ok']) {
                continue;
            }
            $html = html_entity_decode($page['body'], ENT_QUOTES | ENT_HTML5);
            if (preg_match_all('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $html, $m)) {
                foreach ($m[0] as $email) {
                    $email = strtolower($email);
                    if (preg_match('/\.(png|jpe?g|gif|webp|svg|css|js)$/', $email) || str_contains($email, 'example.') || str_contains($email, 'sentry')) {
                        continue;
                    }
                    $found[$email] = true;
                }
            }
            if ($found !== []) {
                break;
            }
        }

        $emails = array_keys($found);
        // Prefer an address on the business's own domain, then role-style prefixes.
        usort($emails, function ($a, $b) use ($siteDomain) {
            $score = fn ($e) => (str_ends_with($e, '@'.$siteDomain) ? 0 : 2)
                + (preg_match('/^(info|sales|contact|hello|admin|enquir|inquir|support|office)/', $e) ? 0 : 1);

            return $score($a) <=> $score($b);
        });

        foreach ($emails as $email) {
            if (Suppression::blocks($email)) {
                continue; // opted out: never surface it
            }

            return ['ok' => true, 'public_email' => $email, 'email_source' => 'website'];
        }

        return ['ok' => true, 'public_email' => null, 'reason' => 'none_published'];
    }
}
