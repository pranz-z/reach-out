<?php

namespace App\Services\Llm;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Talks to any OpenAI-compatible /chat/completions endpoint
 * (Ollama, Groq, Gemini's OpenAI-compat endpoint, a local router, etc.).
 * Switching providers only changes LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
 */
class LlmClient
{
    public function model(): string
    {
        return config('reachout.llm.model');
    }

    /**
     * @param  array<int,array<string,mixed>>  $messages
     * @param  array<int,array<string,mixed>>  $tools  OpenAI-style tool schemas (may be empty)
     * @return array<string,mixed>  The assistant message (role, content, tool_calls?)
     */
    public function chat(array $messages, array $tools = []): array
    {
        $payload = [
            'model' => $this->model(),
            'messages' => $messages,
            'temperature' => 0.3,
        ];
        if ($tools !== []) {
            $payload['tools'] = $tools;
            $payload['tool_choice'] = 'auto';
        }

        $response = Http::withToken(config('reachout.llm.api_key'))
            ->timeout(config('reachout.llm.timeout'))
            ->acceptJson()
            ->post(config('reachout.llm.base_url').'/chat/completions', $payload);

        if ($response->failed()) {
            throw new RuntimeException('LLM request failed: HTTP '.$response->status().' '.substr($response->body(), 0, 300));
        }

        $message = $response->json('choices.0.message');
        if (! is_array($message)) {
            throw new RuntimeException('LLM response had no message.');
        }

        return $message;
    }
}
