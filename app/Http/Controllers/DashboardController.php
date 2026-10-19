<?php

namespace App\Http\Controllers;

use App\Models\AgentRun;
use App\Models\Draft;
use App\Models\Lead;
use App\Models\Suppression;

class DashboardController extends Controller
{
    public function overview()
    {
        return view('overview', [
            'leadCount' => Lead::count(),
            'pending' => Draft::where('status', 'pending')->count(),
            'approved' => Draft::where('status', 'approved')->count(),
            'sent' => Draft::where('status', 'sent')->count(),
            'optedOut' => Suppression::whereNotNull('email')->count(),
            'runs' => AgentRun::latest()->limit(5)->get(),
        ]);
    }

    public function leads()
    {
        return view('leads', ['leads' => Lead::latest()->limit(200)->get()]);
    }

    public function sent()
    {
        return view('sent', [
            'drafts' => Draft::with('lead')->whereIn('status', ['approved', 'sent'])->latest()->limit(200)->get(),
        ]);
    }

    public function settings()
    {
        return view('settings', [
            'llm' => config('reachout.llm'),
            'suppressions' => Suppression::whereNotNull('email')->latest()->limit(100)->get(),
        ]);
    }
}
