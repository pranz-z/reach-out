<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Models\Draft;
use App\Models\Suppression;
use Illuminate\Http\Request;

class ReviewController extends Controller
{
    public function index()
    {
        return view('review', [
            'drafts' => Draft::with('lead')->where('status', 'pending')->latest()->get(),
        ]);
    }

    public function approve(Request $request, Draft $draft)
    {
        abort_unless($draft->status === 'pending', 409);

        $data = $request->validate([
            'subject' => ['required', 'string', 'max:120'],
            'body' => ['required', 'string', 'max:3000'],
        ]);

        // Re-validate after human edits: the opt-out line must survive editing.
        $marker = config('reachout.required_opt_out_marker');
        if (! preg_match('/reply\s+"?'.preg_quote($marker, '/').'"?/i', $data['body'])) {
            return back()->withErrors(['body' => "The email must keep an opt-out line (reply {$marker})."]);
        }
        if ($draft->lead->public_email && Suppression::blocks($draft->lead->public_email)) {
            return back()->withErrors(['body' => 'This address is on the suppression list.']);
        }

        $draft->update($data + ['status' => 'approved', 'approved_at' => now()]);
        $draft->lead->update(['status' => 'approved']);
        AuditLog::record('draft', $draft->id, 'approved', ['edited' => $draft->wasChanged(['subject', 'body'])]);

        // Sending is milestone 4: approved drafts wait in the "Sent & replies" tab until it is built.
        return back()->with('status', 'Approved. It is queued and will go out once sending is enabled.');
    }

    public function reject(Draft $draft)
    {
        abort_unless($draft->status === 'pending', 409);

        $draft->update(['status' => 'rejected']);
        $draft->lead->update(['status' => 'rejected']);
        AuditLog::record('draft', $draft->id, 'rejected');

        return back()->with('status', 'Draft rejected.');
    }
}
