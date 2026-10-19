<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AuditLog extends Model
{
    protected $table = 'audit_log';

    public $timestamps = false;

    protected $fillable = ['entity', 'entity_id', 'action', 'meta'];

    protected $casts = ['meta' => 'array', 'created_at' => 'datetime'];

    public static function record(string $entity, ?int $id, string $action, array $meta = []): void
    {
        static::create(['entity' => $entity, 'entity_id' => $id, 'action' => $action, 'meta' => $meta]);
    }
}
