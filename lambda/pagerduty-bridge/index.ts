import * as https from 'https';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { SNSEvent } from 'aws-lambda';

const sm = new SecretsManagerClient({});

let cachedKey: string | undefined;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getIntegrationKey(): Promise<string> {
  if (cachedKey && Date.now() < cacheExpiresAt) return cachedKey;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.PD_SECRET_ARN! }));
  cachedKey = res.SecretString!;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedKey;
}

function postToPagerDuty(body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'events.pagerduty.com',
        path: '/v2/enqueue',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const integrationKey = await getIntegrationKey();

  for (const record of event.Records) {
    const alarm = JSON.parse(record.Sns.Message);

    const payload = {
      routing_key: integrationKey,
      event_action: alarm.NewStateValue === 'ALARM' ? 'trigger' : 'resolve',
      dedup_key: alarm.AlarmName,
      payload: {
        summary: alarm.AlarmDescription || alarm.AlarmName,
        severity: 'critical',
        source: alarm.AlarmArn,
        custom_details: {
          alarm_name: alarm.AlarmName,
          state: alarm.NewStateValue,
          reason: alarm.NewStateReason,
          region: alarm.Region,
          account: alarm.AWSAccountId,
        },
      },
    };

    await postToPagerDuty(JSON.stringify(payload));
  }
};
