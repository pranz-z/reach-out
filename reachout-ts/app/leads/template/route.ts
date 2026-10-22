import { CSV_TEMPLATE } from '@/lib/leads';

export function GET() {
  return new Response(CSV_TEMPLATE, {
    headers: {
      'Content-Type': 'text/csv; charset=UTF-8',
      'Content-Disposition': 'attachment; filename="reachout-leads-template.csv"',
    },
  });
}
