<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('search_profiles', function (Blueprint $t) {
            $t->id();
            $t->string('name');
            $t->json('categories');
            $t->json('cities');
            $t->unsignedInteger('daily_cap')->default(10);
            $t->boolean('active')->default(true);
            $t->timestamps();
        });

        Schema::create('leads', function (Blueprint $t) {
            $t->id();
            $t->foreignId('profile_id')->nullable()->constrained('search_profiles')->nullOnDelete();
            $t->string('place_id')->nullable()->unique();
            $t->string('name');
            $t->string('category')->nullable();
            $t->string('address')->nullable();
            $t->string('city')->nullable();
            $t->string('phone')->nullable();
            $t->string('website_url')->nullable();
            $t->string('website_status')->default('unknown'); // none|social_only|basic|modern|unknown
            $t->json('signals')->nullable();
            $t->string('facebook_url')->nullable();
            $t->string('facebook_confidence')->default('none'); // none|unverified|likely
            $t->string('public_email')->nullable();
            $t->string('email_source')->nullable(); // website|manual|csv
            $t->string('fit_score')->nullable();    // high|medium|low
            $t->string('status')->default('new');   // new|enriched|drafted|approved|sent|replied|opted_out|phone_only|rejected
            $t->text('notes')->nullable();
            $t->timestamps();
            $t->index('status');
        });

        Schema::create('drafts', function (Blueprint $t) {
            $t->id();
            $t->foreignId('lead_id')->constrained()->cascadeOnDelete();
            $t->string('kind')->default('first'); // first|followup
            $t->string('subject');
            $t->text('body');
            $t->text('suggestion')->nullable();
            $t->json('found')->nullable();
            $t->string('status')->default('pending'); // pending|approved|rejected|sent
            $t->string('model')->nullable();
            $t->timestamp('approved_at')->nullable();
            $t->timestamps();
            $t->index('status');
        });

        Schema::create('emails', function (Blueprint $t) {
            $t->id();
            $t->foreignId('lead_id')->constrained()->cascadeOnDelete();
            $t->foreignId('draft_id')->nullable()->constrained()->nullOnDelete();
            $t->string('message_id')->nullable();
            $t->timestamp('sent_at')->nullable();
            $t->string('delivery_status')->nullable();
            $t->timestamps();
        });

        Schema::create('replies', function (Blueprint $t) {
            $t->id();
            $t->foreignId('lead_id')->constrained()->cascadeOnDelete();
            $t->timestamp('received_at')->nullable();
            $t->string('classification')->nullable(); // interested|not_interested|stop|unknown
            $t->text('snippet')->nullable();
            $t->timestamps();
        });

        Schema::create('suppressions', function (Blueprint $t) {
            $t->id();
            $t->string('email')->nullable()->index();
            $t->string('domain')->nullable()->index();
            $t->string('reason')->nullable();
            $t->timestamps();
        });

        Schema::create('audit_log', function (Blueprint $t) {
            $t->id();
            $t->string('entity');
            $t->unsignedBigInteger('entity_id')->nullable();
            $t->string('action');
            $t->json('meta')->nullable();
            $t->timestamp('created_at')->useCurrent();
        });

        Schema::create('agent_runs', function (Blueprint $t) {
            $t->id();
            $t->foreignId('profile_id')->nullable()->constrained('search_profiles')->nullOnDelete();
            $t->string('status')->default('running'); // running|finished|stopped|failed
            $t->unsignedInteger('steps_used')->default(0);
            $t->unsignedInteger('leads_saved')->default(0);
            $t->unsignedInteger('drafts_queued')->default(0);
            $t->string('model')->nullable();
            $t->text('error')->nullable();
            $t->timestamp('started_at')->nullable();
            $t->timestamp('finished_at')->nullable();
            $t->timestamps();
        });

        Schema::create('agent_steps', function (Blueprint $t) {
            $t->id();
            $t->foreignId('run_id')->constrained('agent_runs')->cascadeOnDelete();
            $t->unsignedInteger('step');
            $t->string('role');
            $t->string('tool')->nullable();
            $t->json('arguments')->nullable();
            $t->json('result')->nullable();
            $t->timestamp('created_at')->useCurrent();
        });
    }

    public function down(): void
    {
        foreach (['agent_steps', 'agent_runs', 'audit_log', 'suppressions', 'replies', 'emails', 'drafts', 'leads', 'search_profiles'] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
