<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Lead extends Model
{
    protected $fillable = [
        'profile_id', 'place_id', 'name', 'category', 'address', 'city', 'phone',
        'website_url', 'website_status', 'signals', 'facebook_url', 'facebook_confidence',
        'public_email', 'email_source', 'fit_score', 'status', 'notes',
    ];

    protected $casts = ['signals' => 'array'];

    public function drafts()
    {
        return $this->hasMany(Draft::class);
    }

    public function profile()
    {
        return $this->belongsTo(SearchProfile::class, 'profile_id');
    }
}
