@extends('layouts.app')
@section('title', 'Overview')
@section('content')
<h1>Overview</h1>
<p class="sub">Leads, drafts waiting for you, and recent agent runs.</p>

<div class="stats">
  <div class="stat"><small>Leads</small><b>{{ $leadCount }}</b></div>
  <div class="stat"><small>Awaiting review</small><b>{{ $pending }}</b></div>
  <div class="stat"><small>Approved</small><b>{{ $approved }}</b></div>
  <div class="stat"><small>Opted out</small><b>{{ $optedOut }}</b></div>
</div>

<div class="card">
  <h2>Recent agent runs</h2>
  @if($runs->isEmpty())
    <div class="empty">No runs yet. Create a search profile, then run <code>php artisan reachout:run "Your profile"</code>.</div>
  @else
  <table>
    <thead><tr><th>Started</th><th>Status</th><th>Steps</th><th>Leads</th><th>Drafts</th><th>Model</th></tr></thead>
    <tbody>
    @foreach($runs as $run)
      <tr>
        <td>{{ $run->started_at?->diffForHumans() }}</td>
        <td><span class="pill {{ $run->status === 'finished' ? 'p-ok' : ($run->status === 'failed' ? 'p-bad' : 'p-warn') }}">{{ $run->status }}</span></td>
        <td>{{ $run->steps_used }}</td><td>{{ $run->leads_saved }}</td><td>{{ $run->drafts_queued }}</td><td>{{ $run->model }}</td>
      </tr>
    @endforeach
    </tbody>
  </table>
  @endif
</div>
@endsection
