import type { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { createAuthorizer } from './authorizer';

const METHOD_ARN = 'arn:aws:execute-api:ap-southeast-2:000000000000:abc123/live/POST/api/v1/chat';

const event = (token: string): APIGatewayTokenAuthorizerEvent => ({
  type: 'TOKEN',
  authorizationToken: token,
  methodArn: METHOD_ARN,
});

describe('authorizer', () => {
  const authorize = createAuthorizer(async (token) => {
    if (token !== 'good.token.value') throw new Error('invalid');
    return {
      sub: 'reader-sub',
      aud: 'docs-app-client',
      email: 'reader@umccr.org',
      groups: ['bioinfo', 'admin'],
    };
  });

  test('allows every route of the stage for a valid token, and passes the caller on', async () => {
    const result = await authorize(event('Bearer good.token.value'));
    expect(result.principalId).toBe('reader-sub');
    expect(result.context).toEqual({
      sub: 'reader-sub',
      clientId: 'docs-app-client',
      email: 'reader@umccr.org',
      groups: 'bioinfo admin',
    });
    expect(result.policyDocument.Statement).toEqual([
      {
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Resource: 'arn:aws:execute-api:ap-southeast-2:000000000000:abc123/live/*/*',
      },
    ]);
  });

  test('passes an empty email and no groups for a token without them', async () => {
    const bare = createAuthorizer(async () => ({ sub: 'machine', aud: 'client', groups: [] }));
    expect((await bare(event('Bearer any.token.value'))).context).toEqual({
      sub: 'machine',
      clientId: 'client',
      email: '',
      groups: '',
    });
  });

  test.each(['', 'good.token.value', 'Basic abc', 'Bearer bad.token.value', 'Bearer a b'])(
    'refuses %p',
    async (token) => {
      await expect(authorize(event(token))).rejects.toThrow('Unauthorized');
    }
  );
});
