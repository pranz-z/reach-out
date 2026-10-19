<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Draft extends Model
{
    protected $fillable = [
        'lead_id', 'kind', 'subject', 'body', 'suggestion', 'found', 'status', 'model', 'approved_at',
    ];

    protected $casts = [
        'found' => 'array',
        'approved_at' => 'datetime',
    ];

    public function lead()
    {
        return $this->belongsTo(Lead::class);
    }
}
