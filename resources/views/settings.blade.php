@extends('layouts.app')
@section('title', 'Settings')
@section('content')
<h1>Settings</h1>
<p class="sub">Read-only view of what is set in <code>.env</code>. Change values there, then restart the server.</p>

<div class="card">
  <h2>LLM endpoint (OpenAI-compatible)</h2>
  <div class="row"><label>Base URL</label><div>{{ $llm['base_url'] }}</div></div>
  <div class="row"><label>Model</label><div>{{ $llm['model'] }}</div></div>
  <div class="row"><label>API key</label><div>{{ $llm['api_key'] ? 'set' : 'not set' }}</div></div>
</div>

<div class="card">
  <h2>Agent limits</h2>
  <div class="row"><label>Max steps per run</label><div>{{ config('reachout.agent.max_steps') }}</div></div>
  <div class="row"><label>Max leads per run</label><div>{{ config('reachout.agent.max_leads_per_run') }}</div></div>
  <div class="row"><label>Manual approval</label><div>{{ config('reachout.require_approval') ? 'required' : 'off' }}</div></div>
</div>

<div class="card">
  <h2>Suppression list</h2>
  <form method="POST" action="{{ route('suppressions.store') }}" class="inline-form pad">
    @csrf
    <input type="email" name="email" placeholder="Add an opted-out address" required>
    <button class="btn" type="submit">Add</button>
  </form>
  @if($suppressions->isEmpty())
    <div class="empty">No opted-out addresses.</div>
  @else
  <table>
    <thead><tr><th>Address</th><th>Reason</th><th>Added</th></tr></thead>
    <tbody>
    @foreach($suppressions as $s)
      <tr><td>{{ $s->email }}</td><td>{{ $s->reason }}</td><td>{{ $s->created_at->diffForHumans() }}</td></tr>
    @endforeach
    </tbody>
  </table>
  @endif
</div>
@endsection
