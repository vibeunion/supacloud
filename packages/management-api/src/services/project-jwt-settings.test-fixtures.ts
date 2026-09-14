import { exportJWK, generateKeyPair } from "jose";
import { buildAwsKmsRs256JwtKeyMaterial } from "../utils/project-jwt";

export async function kmsJwtFixture() {
  const pair = await generateKeyPair("RS256", { extractable: true });
  return buildAwsKmsRs256JwtKeyMaterial({
    aws_kms_arn: "arn:aws:kms:us-east-1:123456789012:key/test-key",
    public_jwk: await exportJWK(pair.publicKey),
  });
}
