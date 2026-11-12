import { describe, expect, it } from 'vitest';
import { readApiJson } from './apiResponse';

describe('readApiJson', () => {
  it('parses successful JSON responses', async () => {
    const response = new Response(JSON.stringify({ answer: 'Hello' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });

    await expect(readApiJson(response, 'Server AI')).resolves.toEqual({ answer: 'Hello' });
  });

  it('reports an HTML fallback instead of exposing a JSON syntax error', async () => {
    const response = new Response('<!doctype html><html></html>', {
      headers: { 'Content-Type': 'text/html' },
      status: 200,
    });

    await expect(readApiJson(response, 'Server AI')).rejects.toThrow(
      'Server AI trả về HTML thay vì JSON (HTTP 200). Kiểm tra URL backend và cấu hình route /api.',
    );
  });

  it('preserves JSON API error messages', async () => {
    const response = new Response(JSON.stringify({ error: 'Quota exceeded' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 429,
    });

    await expect(readApiJson(response, 'Server AI')).rejects.toThrow('Quota exceeded');
  });
});
