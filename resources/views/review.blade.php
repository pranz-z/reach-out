@extends('layouts.app')
@section('title', 'Review queue')
@section('content')
<h1>Review queue</h1>
<p class="sub">The agent drafts. Nothing is approved until you do it. Check the facts and open the Facebook page yourself, then edit if needed.</p>

@if($drafts->isEmpty())
  <div class="card"><div class="empty">All caught up. No drafts waiting.</div></div>
@else
<div class="card">
  @foreach($drafts as $draft)
    @php($lead = $draft->lead)
    <div class="draft">
      <div class="draft-head">
        <strong>{{ $lead->name }} <span class="meta">· {{ $lead->category }} · {{ $lead->city }}</span></strong>
        <span class="meta">to {{ $lead->public_email }} · model: {{ $draft->model }}</span>
      </div>

      <div class="found">
        <div><b>Found</b></div>
        <ul>
          <li>Website: <span class="pill {{ in_array($lead->website_status, ['none','social_only']) ? 'p-warn' : 'p-info' }}">{{ $lead->website_status }}</span>
            @if($lead->website_url) <span class="meta">{{ $lead->website_url }}</span>@endif</li>
          <li>Facebook:
            @if($lead->facebook_url)
              <a class="btn small" href="{{ $lead->facebook_url }}" target="_blank" rel="noopener noreferrer">Open page</a>
              <span class="meta">{{ $lead->facebook_confidence }} match, check it yourself</span>
            @else <span class="meta">no page found</span>@endif</li>
          @if($lead->phone)<li>Phone: {{ $lead->phone }}</li>@endif
          @foreach(($draft->found ?? []) as $fact)<li>{{ $fact }}</li>@endforeach
        </ul>
        @if($draft->suggestion)<div class="suggest"><b>Suggested:</b> {{ $draft->suggestion }}</div>@endif
      </div>

      <form method="POST" action="{{ route('review.approve', $draft) }}">
        @csrf
        <input type="text" name="subject" value="{{ old('subject', $draft->subject) }}" class="subject-input" maxlength="120">
        <textarea name="body" class="body">{{ old('body', $draft->body) }}</textarea>
        <div class="actions">
          <button class="btn primary" type="submit">Approve &amp; queue</button>
          <button class="btn danger" type="submit" formaction="{{ route('review.reject', $draft) }}" formnovalidate>Reject</button>
        </div>
      </form>
    </div>
  @endforeach
</div>
@endif
@endsection
