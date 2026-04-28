import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { PrivateLinkStack } from './privatelink-stack';
import { Construct } from 'constructs';

interface ObservabilityStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  table: dynamodb.Table;
  apiFunction: lambda.Function;
  authorizerFunction: lambda.Function;
  proberFunction: lambda.Function;
  alarmTopic: sns.Topic;
  restApi: apigateway.RestApi;
  privateLinkStack: PrivateLinkStack;
  authorizerLogGroup: logs.ILogGroup;
  proberLogGroup: logs.ILogGroup;
  docDbApiFunction?: lambda.Function;
  docDbClusterIdentifier?: string;
}

interface MetricFilters {
  authFailureMetric: cloudwatch.Metric;
}

export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const alarmAction = new cloudwatch_actions.SnsAction(props.alarmTopic);

    const { authFailureMetric } = this.createMetricFilters(props);
    const { alarms, proberAvailabilityAlarm, apiErrorRateAlarm } = this.createAlarms(props, alarmAction, authFailureMetric);
    this.createDashboard(props, alarms, authFailureMetric);

    // SLO composite alarm — triggers PagerDuty P1 on any critical condition
    new cloudwatch.CompositeAlarm(this, 'CriticalSloAlarm', {
      compositeAlarmName: 'cloud-acceleration-slo-critical',
      alarmDescription: 'P1: Critical SLO breach — immediate response required',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(proberAvailabilityAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(apiErrorRateAlarm, cloudwatch.AlarmState.ALARM),
      ),
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=CloudAcceleration-Operations`,
    });
  }

  private createMetricFilters(props: ObservabilityStackProps): MetricFilters {
    const authFailureFilter = new logs.MetricFilter(this, 'AuthFailureFilter', {
      logGroup: props.authorizerLogGroup,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.level', '=', 'WARN'),
        logs.FilterPattern.stringValue('$.message', '=', '*UNAUTHORIZED*'),
      ),
      metricNamespace: 'CloudAcceleration/Authorizer',
      metricName: 'AuthFailures',
      metricValue: '1',
      defaultValue: 0,
    });

    new logs.MetricFilter(this, 'ProberAvailabilityFilter', {
      logGroup: props.proberLogGroup,
      filterPattern: logs.FilterPattern.exists('$.availability'),
      metricNamespace: 'CloudAcceleration/Prober',
      metricName: 'Availability',
      metricValue: '$.availability',
      defaultValue: 0,
    });

    new logs.MetricFilter(this, 'ProberLatencyFilter', {
      logGroup: props.proberLogGroup,
      filterPattern: logs.FilterPattern.exists('$.latencyMs'),
      metricNamespace: 'CloudAcceleration/Prober',
      metricName: 'FunctionalLatency',
      metricValue: '$.latencyMs',
      defaultValue: 0,
    });

    return {
      authFailureMetric: authFailureFilter.metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
    };
  }

  private createAlarms(
    props: ObservabilityStackProps,
    alarmAction: cloudwatch_actions.SnsAction,
    authFailureMetric: cloudwatch.Metric,
  ): { alarms: cloudwatch.Alarm[]; proberAvailabilityAlarm: cloudwatch.Alarm; apiErrorRateAlarm: cloudwatch.Alarm } {
    const alarms: cloudwatch.Alarm[] = [];

    const addAlarm = (alarm: cloudwatch.Alarm): cloudwatch.Alarm => {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
      alarms.push(alarm);
      return alarm;
    };

    const apiErrorRate = new cloudwatch.MathExpression({
      expression: '(errors / invocations) * 100',
      usingMetrics: {
        errors: props.apiFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
        invocations: props.apiFunction.metricInvocations({ period: cdk.Duration.minutes(5) }),
      },
      label: 'API Error Rate %',
      period: cdk.Duration.minutes(5),
    });

    const apiErrorRateAlarm = addAlarm(new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: 'cloud-acceleration-api-error-rate',
      alarmDescription: 'API Lambda error rate > 1% — NIST SI-4',
      metric: apiErrorRate,
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    addAlarm(new cloudwatch.Alarm(this, 'ApiP99LatencyAlarm', {
      alarmName: 'cloud-acceleration-api-p99-latency',
      alarmDescription: 'API Lambda P99 latency > 10s',
      metric: props.apiFunction.metricDuration({ statistic: 'p99', period: cdk.Duration.minutes(5) }),
      threshold: 10000,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // Elevated auth failures may indicate a brute-force attempt — NIST SI-4
    addAlarm(new cloudwatch.Alarm(this, 'AuthFailureAlarm', {
      alarmName: 'cloud-acceleration-auth-failures',
      alarmDescription: 'Elevated auth failures — possible brute force — NIST SI-4',
      metric: authFailureMetric,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    addAlarm(new cloudwatch.Alarm(this, 'DynamoSystemErrorAlarm', {
      alarmName: 'cloud-acceleration-dynamo-system-errors',
      alarmDescription: 'DynamoDB system errors detected',
      metric: props.table.metric('SystemErrors', { statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    addAlarm(new cloudwatch.Alarm(this, 'DynamoThrottleAlarm', {
      alarmName: 'cloud-acceleration-dynamo-throttles',
      alarmDescription: 'DynamoDB throttled requests — capacity planning needed',
      metric: props.table.metric('ThrottledRequests', { statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    const proberAvailabilityAlarm = addAlarm(new cloudwatch.Alarm(this, 'ProberAvailabilityAlarm', {
      alarmName: 'cloud-acceleration-prober-availability',
      alarmDescription: 'Application functional health check failed — NIST SI-6',
      metric: new cloudwatch.Metric({
        namespace: 'CloudAcceleration/Prober',
        metricName: 'Availability',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    addAlarm(new cloudwatch.Alarm(this, 'ProberLatencyAlarm', {
      alarmName: 'cloud-acceleration-prober-latency',
      alarmDescription: 'Functional health check latency elevated > 5s',
      metric: new cloudwatch.Metric({
        namespace: 'CloudAcceleration/Prober',
        metricName: 'FunctionalLatency',
        statistic: 'p95',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    addAlarm(new cloudwatch.Alarm(this, 'ApiGw5xxAlarm', {
      alarmName: 'cloud-acceleration-apigw-5xx',
      alarmDescription: 'API Gateway 5XX error rate elevated',
      metric: props.restApi.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // Elevated 4XX may indicate auth attacks — NIST SI-4
    addAlarm(new cloudwatch.Alarm(this, 'ApiGw4xxAlarm', {
      alarmName: 'cloud-acceleration-apigw-4xx',
      alarmDescription: 'API Gateway 4XX error rate elevated — potential security event',
      metric: props.restApi.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 100,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    addAlarm(new cloudwatch.Alarm(this, 'ApiThrottleAlarm', {
      alarmName: 'cloud-acceleration-api-throttles',
      alarmDescription: 'API Lambda throttles detected',
      metric: props.apiFunction.metricThrottles({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    const nlbDimensions = { LoadBalancer: props.privateLinkStack.nlbFullName };
    const nlbUnhealthyHosts = new cloudwatch.Metric({
      namespace: 'AWS/NetworkELB',
      metricName: 'UnHealthyHostCount',
      dimensionsMap: nlbDimensions,
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      label: 'Unhealthy Hosts',
    });

    addAlarm(new cloudwatch.Alarm(this, 'NlbUnhealthyHostsAlarm', {
      alarmName: 'cloud-acceleration-nlb-unhealthy-hosts',
      alarmDescription: 'PrivateLink NLB has unhealthy targets — consumer access may be degraded',
      metric: nlbUnhealthyHosts,
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    if (props.docDbApiFunction) {
      const docDbErrorRate = new cloudwatch.MathExpression({
        expression: '(errors / invocations) * 100',
        usingMetrics: {
          errors: props.docDbApiFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
          invocations: props.docDbApiFunction.metricInvocations({ period: cdk.Duration.minutes(5) }),
        },
        label: 'DocDB API Error Rate %',
        period: cdk.Duration.minutes(5),
      });

      addAlarm(new cloudwatch.Alarm(this, 'DocDbApiErrorRateAlarm', {
        alarmName: 'cloud-acceleration-docdb-api-error-rate',
        alarmDescription: 'DocumentDB CRUD Lambda error rate > 1% — NIST SI-4',
        metric: docDbErrorRate,
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    }

    if (props.docDbClusterIdentifier) {
      const docDbDimensions = { DBClusterIdentifier: props.docDbClusterIdentifier };

      addAlarm(new cloudwatch.Alarm(this, 'DocDbCpuAlarm', {
        alarmName: 'cloud-acceleration-docdb-cpu',
        alarmDescription: 'DocumentDB CPU > 80% — possible capacity bottleneck',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DocDB',
          metricName: 'CPUUtilization',
          dimensionsMap: docDbDimensions,
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 80,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));

      addAlarm(new cloudwatch.Alarm(this, 'DocDbReplicaLagAlarm', {
        alarmName: 'cloud-acceleration-docdb-replica-lag',
        alarmDescription: 'DocumentDB replica lag > 1s',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DocDB',
          metricName: 'DBInstanceReplicaLag',
          dimensionsMap: docDbDimensions,
          statistic: 'Maximum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1000,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));

      addAlarm(new cloudwatch.Alarm(this, 'DocDbConnectionsAlarm', {
        alarmName: 'cloud-acceleration-docdb-connections',
        alarmDescription: 'DocumentDB connection count elevated > 1000',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DocDB',
          metricName: 'DatabaseConnections',
          dimensionsMap: docDbDimensions,
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1000,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    }

    return { alarms, proberAvailabilityAlarm, apiErrorRateAlarm };
  }

  private createDashboard(
    props: ObservabilityStackProps,
    alarms: cloudwatch.Alarm[],
    authFailureMetric: cloudwatch.Metric,
  ): void {
    const dashboard = new cloudwatch.Dashboard(this, 'MainDashboard', {
      dashboardName: 'CloudAcceleration-Operations',
      defaultInterval: cdk.Duration.hours(3),
    });

    const nlbDimensions = { LoadBalancer: props.privateLinkStack.nlbFullName };

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Cloud Acceleration — Operations Dashboard\nNIST-compliant financial infrastructure',
        width: 24,
        height: 2,
      }),
    );

    // Row 1: API health
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Invocations & Errors',
        width: 8,
        left: [props.apiFunction.metricInvocations({ period: cdk.Duration.minutes(1) })],
        right: [props.apiFunction.metricErrors({ period: cdk.Duration.minutes(1) })],
        leftYAxis: { label: 'Invocations', showUnits: false },
        rightYAxis: { label: 'Errors', showUnits: false },
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency (P50 / P95 / P99)',
        width: 8,
        left: [
          props.apiFunction.metricDuration({ statistic: 'p50', period: cdk.Duration.minutes(5), label: 'P50' }),
          props.apiFunction.metricDuration({ statistic: 'p95', period: cdk.Duration.minutes(5), label: 'P95' }),
          props.apiFunction.metricDuration({ statistic: 'p99', period: cdk.Duration.minutes(5), label: 'P99' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway — 4XX / 5XX',
        width: 8,
        left: [
          props.restApi.metricClientError({ period: cdk.Duration.minutes(1), label: '4XX' }),
          props.restApi.metricServerError({ period: cdk.Duration.minutes(1), label: '5XX' }),
        ],
      }),
    );

    // Row 2: Auth & security
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Auth Failures (NIST SI-4)',
        width: 8,
        left: [authFailureMetric],
      }),
      new cloudwatch.GraphWidget({
        title: 'Authorizer Latency',
        width: 8,
        left: [props.authorizerFunction.metricDuration({ statistic: 'p95', period: cdk.Duration.minutes(5) })],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        width: 8,
        left: [
          props.apiFunction.metricThrottles({ period: cdk.Duration.minutes(1), label: 'API' }),
          props.authorizerFunction.metricThrottles({ period: cdk.Duration.minutes(1), label: 'Authorizer' }),
        ],
      }),
    );

    // Row 3: DynamoDB
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read / Write Capacity Consumed',
        width: 8,
        left: [props.table.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(1) })],
        right: [props.table.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(1) })],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Latency',
        width: 8,
        left: [
          props.table.metricSuccessfulRequestLatency({ dimensionsMap: { Operation: 'GetItem' }, statistic: 'p99', period: cdk.Duration.minutes(5), label: 'GetItem P99' }),
          props.table.metricSuccessfulRequestLatency({ dimensionsMap: { Operation: 'PutItem' }, statistic: 'p99', period: cdk.Duration.minutes(5), label: 'PutItem P99' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Errors & Throttles',
        width: 8,
        left: [
          props.table.metric('ThrottledRequests', { statistic: 'Sum', period: cdk.Duration.minutes(1), label: 'Throttles' }),
          props.table.metric('SystemErrors', { statistic: 'Sum', period: cdk.Duration.minutes(1), label: 'System Errors' }),
        ],
      }),
    );

    // Row 4: PrivateLink NLB health
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'PrivateLink NLB — Healthy / Unhealthy Hosts',
        width: 8,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/NetworkELB',
          metricName: 'HealthyHostCount',
          dimensionsMap: nlbDimensions,
          statistic: 'Minimum',
          period: cdk.Duration.minutes(1),
          label: 'Healthy Hosts',
        })],
        right: [new cloudwatch.Metric({
          namespace: 'AWS/NetworkELB',
          metricName: 'UnHealthyHostCount',
          dimensionsMap: nlbDimensions,
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
          label: 'Unhealthy Hosts',
        })],
      }),
      new cloudwatch.GraphWidget({
        title: 'PrivateLink NLB — Active Flow Count',
        width: 8,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/NetworkELB',
          metricName: 'ActiveFlowCount',
          dimensionsMap: nlbDimensions,
          statistic: 'Average',
          period: cdk.Duration.minutes(1),
          label: 'Active Flows',
        })],
      }),
      new cloudwatch.GraphWidget({
        title: 'PrivateLink NLB — Processed Bytes',
        width: 8,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/NetworkELB',
          metricName: 'ProcessedBytes',
          dimensionsMap: nlbDimensions,
          statistic: 'Sum',
          period: cdk.Duration.minutes(1),
          label: 'Bytes',
        })],
      }),
    );

    // Row 4b: DocumentDB
    if (props.docDbClusterIdentifier && props.docDbApiFunction) {
      const docDbDimensions = { DBClusterIdentifier: props.docDbClusterIdentifier };
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'DocumentDB CPU / Connections',
          width: 8,
          left: [new cloudwatch.Metric({
            namespace: 'AWS/DocDB', metricName: 'CPUUtilization',
            dimensionsMap: docDbDimensions, statistic: 'Average',
            period: cdk.Duration.minutes(1), label: 'CPU %',
          })],
          right: [new cloudwatch.Metric({
            namespace: 'AWS/DocDB', metricName: 'DatabaseConnections',
            dimensionsMap: docDbDimensions, statistic: 'Sum',
            period: cdk.Duration.minutes(1), label: 'Connections',
          })],
        }),
        new cloudwatch.GraphWidget({
          title: 'DocumentDB Replica Lag (ms)',
          width: 8,
          left: [new cloudwatch.Metric({
            namespace: 'AWS/DocDB', metricName: 'DBInstanceReplicaLag',
            dimensionsMap: docDbDimensions, statistic: 'Maximum',
            period: cdk.Duration.minutes(1), label: 'Max Replica Lag',
          })],
        }),
        new cloudwatch.GraphWidget({
          title: 'DocDB CRUD Lambda — Latency / Errors',
          width: 8,
          left: [props.docDbApiFunction.metricDuration({ statistic: 'p95', period: cdk.Duration.minutes(5), label: 'P95 ms' })],
          right: [props.docDbApiFunction.metricErrors({ period: cdk.Duration.minutes(5), label: 'Errors' })],
        }),
      );
    }

    // Row 5: Prober functional uptime
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Functional Availability (Prober)',
        width: 8,
        left: [new cloudwatch.Metric({
          namespace: 'CloudAcceleration/Prober',
          metricName: 'Availability',
          statistic: 'Average',
          period: cdk.Duration.minutes(1),
          label: 'Availability',
        })],
        leftYAxis: { min: 0, max: 1 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Functional Latency — End-to-End (Prober)',
        width: 8,
        left: [new cloudwatch.Metric({
          namespace: 'CloudAcceleration/Prober',
          metricName: 'FunctionalLatency',
          statistic: 'p95',
          period: cdk.Duration.minutes(5),
          label: 'P95 Latency (ms)',
        })],
      }),
      new cloudwatch.AlarmStatusWidget({
        title: 'Active Alarms',
        width: 8,
        alarms,
      }),
    );
  }
}
