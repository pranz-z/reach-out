<?php

namespace App\Services\Agent\Tools;

use App\Models\Suppression;

class CheckSuppressionTool extends Tool
{
    public function name(): string
    {
        return 'check_suppression';
    }

    public function description(): string
    {
        return 'Check whether an email address (or its domain) has opted out. If suppressed, never email it.';
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => ['email' => ['type' => 'string']],
            'required' => ['email'],
        ];
    }

    public function execute(array $args): array
    {
        $email = trim((string) ($args['email'] ?? ''));
        if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $this->error('not a valid email address');
        }

        return ['ok' => true, 'suppressed' => Suppression::blocks($email)];
    }
}
