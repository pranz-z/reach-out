@extends('layouts.app')
@section('title', 'Leads')
@section('content')
<h1>Leads</h1>
<p class="sub">Public business details only. Import a CSV, or let the agent find leads.</p>

<form method="POST" action="{{ route('leads.import') }}" enctype="multipart/form-data" class="inline-form">
  @csrf
  <input type="file" name="csv" accept=".csv,.txt" required>
  <button class="btn primary" type="submit">Import CSV</button>
  <span class="meta">Columns: name, city (required); category, website_url, public_email, phone, facebook_url</span>
</form>

<div class="card">
  @if($leads->isEmpty())
    <div class="empty">No leads yet.</div>
  @else
  <table>
    <thead><tr><th>Business</th><th>Category</th><th>City</th><th>Website</th><th>Facebook</th><th>Public email</th><th>Fit</th><th>Status</th></tr></thead>
    <tbody>
    @foreach($leads as $lead)
      <tr>
        <td>{{ $lead->name }}</td>
        <td>{{ $lead->category }}</td>
        <td>{{ $lead->city }}</td>
        <td><span class="pill {{ in_array($lead->website_status, ['none','social_only']) ? 'p-warn' : 'p-info' }}">{{ $lead->website_status }}</span></td>
        <td>@if($lead->facebook_url)<a href="{{ $lead->facebook_url }}" target="_blank" rel="noopener noreferrer">Open page</a> <span class="meta">({{ $lead->facebook_confidence }})</span>@else <span class="meta">none</span>@endif</td>
        <td>{{ $lead->public_email ?? '—' }}</td>
        <td>{{ $lead->fit_score ?? '—' }}</td>
        <td><span class="pill {{ in_array($lead->status, ['opted_out','rejected']) ? 'p-bad' : (in_array($lead->status, ['drafted','approved']) ? 'p-warn' : 'p-info') }}">{{ $lead->status }}</span></td>
      </tr>
    @endforeach
    </tbody>
  </table>
  @endif
</div>
@endsection
