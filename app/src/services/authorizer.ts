import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';

/** The claims the authorizer passes on, from a verified Cognito ID token. */
export interface VerifiedClaims {
  readonly sub: string;
  /** For an ID token, the app client the reader signed in through. */
  readonly aud: string;
}

/**
 * The API's Lambda authorizer (a TOKEN authorizer on `Authorization`). It accepts a Cognito ID token issued to an
 * allowed app client, the way the OrcaBus APIs accept the portal's, and passes the reader's `sub` and client ID to the
 * functions.
 *
 * API Gateway caches the result for five minutes per token, so the policy allows every route of the stage: a token
 * that is valid for one route is valid for all of them. Anything else is `Unauthorized`, which API Gateway turns into
 * a 401 without calling a function.
 */
export const createAuthorizer =
  (verify: (token: string) => Promise<VerifiedClaims>) =>
  async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    const match = /^Bearer ([A-Za-z0-9_=.-]+)$/.exec(event.authorizationToken ?? '');
    if (!match?.[1]) {
      throw new Error('Unauthorized');
    }
    let claims: VerifiedClaims;
    try {
      claims = await verify(match[1]);
    } catch {
      throw new Error('Unauthorized');
    }

    // arn:aws:execute-api:<region>:<account>:<api-id>/<stage>/<method>/<path>
    const [apiArn, stage] = event.methodArn.split('/');
    return {
      principalId: claims.sub,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Action: 'execute-api:Invoke', Effect: 'Allow', Resource: `${apiArn}/${stage}/*/*` },
        ],
      },
      context: { sub: claims.sub, clientId: claims.aud },
    };
  };
