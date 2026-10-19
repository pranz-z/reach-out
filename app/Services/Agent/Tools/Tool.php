<?php

namespace App\Services\Agent\Tools;

use App\Models\AgentRun;
use App\Models\SearchProfile;

/**
 * A tool the agent may call. Every guardrail lives INSIDE the tool's execute(),
 * never only in the prompt, so the model cannot talk its way around it.
 */
abstract class Tool
{
    public function __construct(protected SearchProfile $profile, protected AgentRun $run)
    {
    }

    abstract public function name(): string;

    abstract public function description(): string;

    /** JSON-schema "parameters" object. */
    abstract public function parameters(): array;

    /** @return array<string,mixed> JSON-serialisable result (errors are returned, not thrown). */
    abstract public function execute(array $args): array;

    public function schema(): array
    {
        return [
            'type' => 'function',
            'function' => [
                'name' => $this->name(),
                'description' => $this->description(),
                'parameters' => $this->parameters(),
            ],
        ];
    }

    protected function error(string $message): array
    {
        return ['ok' => false, 'error' => $message];
    }
}
