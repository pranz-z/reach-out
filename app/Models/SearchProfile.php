<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class SearchProfile extends Model
{
    protected $fillable = ['name', 'categories', 'cities', 'daily_cap', 'active'];

    protected $casts = [
        'categories' => 'array',
        'cities' => 'array',
        'active' => 'boolean',
    ];

    public function leads()
    {
        return $this->hasMany(Lead::class, 'profile_id');
    }
}
