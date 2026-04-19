import { PiRpcBackend } from './src/backend/piRpcBackend';
import { PiAcpBackend } from './src/backend/piAcpBackend';
import { resolveStepLocations } from './src/backend/lineResolver';

async function runTest() {
  const log = (msg: string) => console.log(msg);
  const cwd = process.cwd();
  const question = "How does the TourStackManager handle tangents?";

  console.log('--- Testing PiRpcBackend ---');
  try {
    const backend = new PiRpcBackend(log, "google-antigravity/gemini-3-flash");
    const session = await backend.createSession(cwd);
    const tour = await session.generateTour({
      question,
      cwd
    });
    console.log('Tour generated:', tour.topic);
    console.log('Step count:', tour.steps.length);
    
    const resolvedSteps = resolveStepLocations(tour.steps, cwd);
    console.log('First step resolved line:', resolvedSteps[0].line);
    
    await session.dispose();
  } catch (err) {
    console.error('PiRpcBackend failed:', err);
  }

  console.log('\n--- Testing PiAcpBackend ---');
  try {
    const backend = new PiAcpBackend(log, undefined, "google-antigravity/gemini-3-flash");
    const session = await backend.createSession(cwd);
    const tour = await session.generateTour({
      question,
      cwd
    });
    console.log('Tour generated:', tour.topic);
    console.log('Step count:', tour.steps.length);
    
    const resolvedSteps = resolveStepLocations(tour.steps, cwd);
    console.log('First step resolved line:', resolvedSteps[0].line);

    await session.dispose();
  } catch (err) {
    console.error('PiAcpBackend failed:', err);
  }
}

runTest();
