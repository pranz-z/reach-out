<?php

namespace App\Services\Agent\Tools;

use Illuminate\Support\Facades\Http;
use Throwable;

class SearchPlacesTool extends Tool
{
    public function name(): string
    {
        return 'search_places';
    }

    public function description(): string
    {
        return 'Search Google Places for businesses of one category in one city from the profile. Returns name, address, phone, website (if listed) and place_id. Does not return emails.';
    }

    public function parameters(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'category' => ['type' => 'string', 'description' => 'Business category, e.g. "restaurant". Must be one of the profile categories.'],
                'city' => ['type' => 'string', 'description' => 'City or municipality. Must be one of the profile cities.'],
            ],
            'required' => ['category', 'city'],
        ];
    }

    public function execute(array $args): array
    {
        $category = trim((string) ($args['category'] ?? ''));
        $city = trim((string) ($args['city'] ?? ''));

        // Guardrail: only profile categories and cities (Philippines only).
        $cities = array_map('mb_strtolower', $this->profile->cities);
        $categories = array_map('mb_strtolower', $this->profile->categories);
        if (! in_array(mb_strtolower($city), $cities, true)) {
            return $this->error('City is not in this profile. Allowed: '.implode(', ', $this->profile->cities));
        }
        if (! in_array(mb_strtolower($category), $categories, true)) {
            return $this->error('Category is not in this profile. Allowed: '.implode(', ', $this->profile->categories));
        }

        $key = config('reachout.places.api_key');
        if (! $key) {
            return $this->error('PLACES_API_KEY is not configured.');
        }

        try {
            $response = Http::withHeaders([
                'X-Goog-Api-Key' => $key,
                'X-Goog-FieldMask' => 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName',
            ])->timeout(15)->post('https://places.googleapis.com/v1/places:searchText', [
                'textQuery' => "{$category} in {$city}, Philippines",
                'regionCode' => 'PH',
                'maxResultCount' => 10,
            ]);
        } catch (Throwable $e) {
            return $this->error('Places request failed.');
        }

        if ($response->failed()) {
            return $this->error('Places API returned HTTP '.$response->status());
        }

        $results = [];
        foreach ((array) $response->json('places', []) as $place) {
            $address = $place['formattedAddress'] ?? '';
            // Guardrail: results must be Philippine addresses.
            if (stripos($address, 'Philippines') === false) {
                continue;
            }
            $results[] = [
                'place_id' => $place['id'] ?? null,
                'name' => $place['displayName']['text'] ?? null,
                'category' => $place['primaryTypeDisplayName']['text'] ?? $category,
                'address' => $address,
                'city' => $city,
                'phone' => $place['nationalPhoneNumber'] ?? null,
                'website_url' => $place['websiteUri'] ?? null,
            ];
        }

        return ['ok' => true, 'count' => count($results), 'places' => $results];
    }
}
