<?php

return [
    'sender_name' => env('SENDER_NAME', 'Your Name'),
    'sender_address' => env('SENDER_ADDRESS', 'you@example.com'),
    'portfolio_url' => env('PORTFOLIO_URL', 'https://example.com/portfolio'),
    'daily_send_limit' => (int) env('DAILY_SEND_LIMIT', 20),
    'require_approval' => (bool) env('REQUIRE_APPROVAL', true),

    'llm' => [
        'base_url' => rtrim(env('LLM_BASE_URL', 'http://localhost:11434/v1'), '/'),
        'api_key' => env('LLM_API_KEY', 'ollama'),
        'model' => env('LLM_MODEL', 'qwen2.5:7b'),
        'timeout' => (int) env('LLM_TIMEOUT', 120),
    ],

    'agent' => [
        'max_steps' => (int) env('AGENT_MAX_STEPS', 40),
        'max_leads_per_run' => (int) env('AGENT_MAX_LEADS_PER_RUN', 10),
        'tool_call_caps' => [
            'search_places' => 6,
            'check_website' => 15,
            'find_facebook_link' => 15,
            'find_public_email' => 15,
            'check_suppression' => 30,
            'save_lead' => 15,
            'queue_draft_for_review' => 25,
            'list_draftable_leads' => 3,
        ],
    ],

    'places' => [
        'api_key' => env('PLACES_API_KEY'),
    ],

    'search' => [
        'provider' => env('SEARCH_PROVIDER', 'brave'), // brave | google
        'api_key' => env('SEARCH_API_KEY'),
        'engine_id' => env('SEARCH_ENGINE_ID'),
    ],

    'http' => [
        'user_agent' => env('REACHOUT_USER_AGENT', 'ReachOutBot/0.1 (+contact: set SENDER_ADDRESS)'),
        'timeout' => 10,
    ],

    // Every email must carry these.
    'required_opt_out_marker' => 'STOP',
    'max_email_words' => 150,
];
