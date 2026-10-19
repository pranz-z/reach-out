<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AgentRun extends Model
{
    protected $fillable = [
        'profile_id', 'status', 'steps_used', 'leads_saved', 'drafts_queued',
        'model', 'error', 'started_at', 'finished_at',
    ];

    protected $casts = ['started_at' => 'datetime', 'finished_at' => 'datetime'];

    public function steps()
    {
        return $this->hasMany(AgentStep::class, 'run_id');
    }
}
