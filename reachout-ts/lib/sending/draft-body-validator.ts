import { config } from '../config';

/**
 * Port of DraftBodyValidator — the draft-body rules shared by the agent's
 * queue_draft tool and the on-demand drafters: opt-out line, sender name,
 * portfolio link, word limit, plain text.
 */
export const DraftBodyValidator = {
  errors(subject: string, body: string): string[] {
    const errors: string[] = [];
    if (subject.trim() === '' || subject.length > 120) {
      errors.push('subject is required and must be under 120 characters');
    }
    if (!new RegExp(`reply\\s+"?${config.requiredOptOutMarker}"?`, 'i').test(body)) {
      errors.push('missing opt-out line');
    }
    if (!body.toLowerCase().includes(config.senderName.toLowerCase())) {
      errors.push('missing sender name');
    }
    if (!body.toLowerCase().includes(config.portfolioUrl.toLowerCase())) {
      errors.push('missing portfolio link');
    }
    if (body.trim().split(/\s+/).filter(Boolean).length > config.maxEmailWords) {
      errors.push(`over ${config.maxEmailWords} words`);
    }
    if (/<[a-z][^>]*>/i.test(body)) {
      errors.push('contains HTML');
    }
    return errors;
  },
};
