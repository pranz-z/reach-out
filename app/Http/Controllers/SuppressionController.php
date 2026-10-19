<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Models\Lead;
use App\Models\Suppression;
use Illuminate\Http\Request;

class SuppressionController extends Controller
{
    /** Manually record an opt-out (for example from a STOP reply). Blocks the address and its domain. */
    public function store(Request $request)
    {
        $data = $request->validate(['email' => ['required', 'email']]);
        $email = strtolower($data['email']);

        Suppression::add($email, 'manual opt-out');
        Lead::where('public_email', $email)->update(['status' => 'opted_out']);
        AuditLog::record('suppression', null, 'added', ['email' => $email]);

        return back()->with('status', "{$email} added to the suppression list.");
    }
}
