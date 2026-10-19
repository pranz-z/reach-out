<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AgentStep extends Model
{
    public $timestamps = false;

    protected $fillable = ['run_id', 'step', 'role', 'tool', 'arguments', 'result'];

    protected $casts = ['arguments' => 'array', 'result' => 'array'];
}
