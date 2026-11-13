import { describe, expect, it } from 'vitest';
import { GeminiRequestAdmission } from './geminiRequestAdmission';

describe('GeminiRequestAdmission', () => {
  it('keeps the active limit while handing a released slot to the oldest waiter', async () => {
    const admission = new GeminiRequestAdmission(1, 2);
    const releaseFirst = await admission.acquire('member-1');
    const second = admission.acquire('member-1');
    const third = admission.acquire('member-1');

    releaseFirst();
    const releaseSecond = await second;
    releaseSecond();
    const releaseThird = await third;
    releaseThird();
  });

  it('removes an aborted waiter without consuming a later slot', async () => {
    const admission = new GeminiRequestAdmission(1, 1);
    const releaseActive = await admission.acquire('member-1');
    const controller = new AbortController();
    const waiting = admission.acquire('member-1', controller.signal);
    controller.abort(new Error('Client disconnected.'));

    await expect(waiting).rejects.toThrow('Client disconnected.');
    releaseActive();

    const releaseNext = await admission.acquire('member-1');
    releaseNext();
  });

  it('rejects requests once the bounded queue is full', async () => {
    const admission = new GeminiRequestAdmission(1, 1);
    const releaseActive = await admission.acquire('member-1');
    const waiting = admission.acquire('member-1');

    await expect(admission.acquire('member-1')).rejects.toThrow('queue is full');

    releaseActive();
    (await waiting)();
  });
});
