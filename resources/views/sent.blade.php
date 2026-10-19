@extends('layouts.app')
@section('title', 'Sent & replies')
@section('content')
<h1>Sent &amp; replies</h1>
<p class="sub">Approved emails wait here. Sending, reply tracking, and follow-up arrive in milestones 4 and 5.</p>

<div class="card">
  @if($drafts->isEmpty())
    <div class="empty">Nothing approved yet.</div>
  @else
  <table>
    <thead><tr><th>Business</th><th>To</th><th>Subject</th><th>Approved</th><th>Status</th></tr></thead>
    <tbody>
    @foreach($drafts as $draft)
      <tr>
        <td>{{ $draft->lead->name }}</td>
        <td>{{ $draft->lead->public_email }}</td>
        <td>{{ $draft->subject }}</td>
        <td>{{ $draft->approved_at?->diffForHumans() }}</td>
        <td><span class="pill {{ $draft->status === 'sent' ? 'p-ok' : 'p-warn' }}">{{ $draft->status === 'approved' ? 'approved, not sent yet' : $draft->status }}</span></td>
      </tr>
    @endforeach
    </tbody>
  </table>
  @endif
</div>
@endsection
