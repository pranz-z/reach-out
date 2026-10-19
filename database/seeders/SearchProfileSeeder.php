<?php

namespace Database\Seeders;

use App\Models\SearchProfile;
use Illuminate\Database\Seeder;

class SearchProfileSeeder extends Seeder
{
    public function run(): void
    {
        // Philippines-only. The agent can only search categories and cities listed here.
        SearchProfile::firstOrCreate(
            ['name' => 'Pampanga food and retail'],
            [
                'categories' => ['restaurant', 'cafe', 'pharmacy', 'hardware store', 'salon'],
                'cities' => ['Guagua', 'Lubao', 'Angeles', 'San Fernando'],
                'daily_cap' => 10,
                'active' => true,
            ]
        );
    }
}
