import { answerCopilotQuestion } from '@/src/services/copilot/copilotService';
import { parseCopilotRequest } from '@/src/services/copilot/requestValidation';
import { runDashboard } from '@/src/lib/dashboardData';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const parsed = parseCopilotRequest(body);
  if (!parsed) {
    return Response.json(
      { error: 'Request body must include a string query of 1000 characters or fewer.' },
      { status: 400 },
    );
  }

  const response = await answerCopilotQuestion(parsed, runDashboard());
  return Response.json(response);
}
