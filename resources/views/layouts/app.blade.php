<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="{{ csrf_token() }}">
<title>ReachOut · @yield('title', 'Dashboard')</title>
<link rel="stylesheet" href="{{ asset('css/reachout.css') }}">
</head>
<body>
<div class="app">
  <aside>
    <div class="logo">Reach<span>Out</span></div>
    <nav>
      @php($pendingCount = \App\Models\Draft::where('status', 'pending')->count())
      <a href="{{ route('overview') }}" class="{{ request()->routeIs('overview') ? 'active' : '' }}">Overview</a>
      <a href="{{ route('leads') }}" class="{{ request()->routeIs('leads') ? 'active' : '' }}">Leads</a>
      <a href="{{ route('review') }}" class="{{ request()->routeIs('review') ? 'active' : '' }}">Review queue
        @if($pendingCount > 0)<span class="count">{{ $pendingCount }}</span>@endif</a>
      <a href="{{ route('sent') }}" class="{{ request()->routeIs('sent') ? 'active' : '' }}">Sent &amp; replies</a>
      <a href="{{ route('settings') }}" class="{{ request()->routeIs('settings') ? 'active' : '' }}">Settings</a>
    </nav>
  </aside>
  <main>
    @if(session('status'))<div class="flash">{{ session('status') }}</div>@endif
    @if($errors->any())<div class="note">@foreach($errors->all() as $error){{ $error }}<br>@endforeach</div>@endif
    @yield('content')
  </main>
</div>
</body>
</html>
