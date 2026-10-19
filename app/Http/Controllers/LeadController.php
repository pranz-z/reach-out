<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Models\Lead;
use App\Models\Suppression;
use App\Services\Support\SafeFetcher;
use Illuminate\Http\Request;

class LeadController extends Controller
{
    /**
     * CSV import. Columns: name, category, city, website_url, public_email, phone, facebook_url
     * Only business details you already have the right to use. Suppressed emails are skipped.
     */
    public function import(Request $request)
    {
        $request->validate(['csv' => ['required', 'file', 'mimes:csv,txt', 'max:2048']]);

        $handle = fopen($request->file('csv')->getRealPath(), 'r');
        $header = array_map(fn ($h) => strtolower(trim($h)), fgetcsv($handle) ?: []);
        if (! in_array('name', $header, true) || ! in_array('city', $header, true)) {
            fclose($handle);

            return back()->withErrors(['csv' => 'CSV needs at least "name" and "city" columns.']);
        }

        $created = $skipped = 0;
        while (($row = fgetcsv($handle)) !== false) {
            $data = array_combine($header, array_pad($row, count($header), null));
            $name = trim((string) ($data['name'] ?? ''));
            $city = trim((string) ($data['city'] ?? ''));
            if ($name === '' || $city === '') {
                $skipped++;

                continue;
            }

            $email = strtolower(trim((string) ($data['public_email'] ?? ''))) ?: null;
            if ($email && (! filter_var($email, FILTER_VALIDATE_EMAIL) || Suppression::blocks($email))) {
                $email = null;
            }
            $website = trim((string) ($data['website_url'] ?? '')) ?: null;
            $facebook = trim((string) ($data['facebook_url'] ?? '')) ?: null;
            if ($facebook && ! preg_match('#^https://([a-z]+\.)?facebook\.com/#i', $facebook)) {
                $facebook = null;
            }

            $lead = Lead::firstOrCreate(
                ['name' => $name, 'city' => $city],
                [
                    'category' => $data['category'] ?? null,
                    'phone' => $data['phone'] ?? null,
                    'website_url' => $website,
                    'website_status' => $website ? (SafeFetcher::isSocial($website) ? 'social_only' : 'unknown') : 'none',
                    'facebook_url' => $facebook,
                    'facebook_confidence' => $facebook ? 'unverified' : 'none',
                    'public_email' => $email,
                    'email_source' => $email ? 'csv' : null,
                    'status' => $email ? 'enriched' : 'phone_only',
                ]
            );
            if ($lead->wasRecentlyCreated) {
                $created++;
                AuditLog::record('lead', $lead->id, 'created', ['by' => 'csv']);
            } else {
                $skipped++;
            }
        }
        fclose($handle);

        return back()->with('status', "Imported {$created} lead(s); skipped {$skipped}.");
    }
}
