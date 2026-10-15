import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createAuthorizer } from '../services/authorizer';

const clientIds = (process.env.CLIENT_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ID tokens only, from the configured user pool and allowed clients. The pool's signing keys are fetched once per
// execution environment and cached.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID ?? '',
  tokenUse: 'id',
  clientId: clientIds,
});

export const handler = createAuthorizer(async (token) => {
  const payload = await verifier.verify(token);
  return { sub: payload.sub, aud: String(payload.aud) };
});
