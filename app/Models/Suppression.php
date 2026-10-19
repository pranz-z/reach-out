<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Suppression extends Model
{
    protected $fillable = ['email', 'domain', 'reason'];

    /** True if the address or its domain is on the suppression list. */
    public static function blocks(string $email): bool
    {
        $email = strtolower(trim($email));
        $domain = substr(strrchr($email, '@') ?: '', 1);

        return static::query()
            ->where('email', $email)
            ->when($domain !== '', fn ($q) => $q->orWhere('domain', $domain))
            ->exists();
    }

    /** Add an address and its domain to the list. */
    public static function add(string $email, string $reason = 'opt-out'): void
    {
        $email = strtolower(trim($email));
        $domain = substr(strrchr($email, '@') ?: '', 1);

        static::firstOrCreate(['email' => $email], ['domain' => $domain ?: null, 'reason' => $reason]);
        if ($domain !== '') {
            static::firstOrCreate(['domain' => $domain, 'email' => null], ['reason' => $reason]);
        }
    }
}
