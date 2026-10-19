<?php

use App\Http\Controllers\DashboardController;
use App\Http\Controllers\LeadController;
use App\Http\Controllers\ReviewController;
use App\Http\Controllers\SuppressionController;
use Illuminate\Support\Facades\Route;

// NOTE: no authentication yet. Run this on localhost only until auth is added (see SETUP.md).
Route::get('/', [DashboardController::class, 'overview'])->name('overview');
Route::get('/leads', [DashboardController::class, 'leads'])->name('leads');
Route::post('/leads/import', [LeadController::class, 'import'])->name('leads.import');
Route::get('/review', [ReviewController::class, 'index'])->name('review');
Route::post('/review/{draft}/approve', [ReviewController::class, 'approve'])->name('review.approve');
Route::post('/review/{draft}/reject', [ReviewController::class, 'reject'])->name('review.reject');
Route::get('/sent', [DashboardController::class, 'sent'])->name('sent');
Route::get('/settings', [DashboardController::class, 'settings'])->name('settings');
Route::post('/suppressions', [SuppressionController::class, 'store'])->name('suppressions.store');
