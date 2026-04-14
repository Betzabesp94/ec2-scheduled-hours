import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';

export interface Ec2StartStopSchedulerProps {
  instanceId: string;
  scheduleStartCron: string;
  scheduleStopCron: string;
  scheduleExpressionTimezone?: string;
}

/**
 * EventBridge Scheduler → universal AWS SDK targets invoking EC2 StartInstances / StopInstances
 * (no Lambda).
 */
export class Ec2StartStopScheduler extends Construct {
  constructor(scope: Construct, id: string, props: Ec2StartStopSchedulerProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const instanceArn = stack.formatArn({
      service: 'ec2',
      resource: 'instance',
      resourceName: props.instanceId,
    });

    const startTargetArn = `arn:${stack.partition}:scheduler:::aws-sdk:ec2:startInstances`;
    const stopTargetArn = `arn:${stack.partition}:scheduler:::aws-sdk:ec2:stopInstances`;

    const ec2Payload = cdk.Fn.sub('{"InstanceIds":["${InstanceId}"]}', {
      InstanceId: props.instanceId,
    });

    const scheduleExpressionTimezone =
      props.scheduleExpressionTimezone ?? 'America/Argentina/Buenos_Aires';

    const startRole = new iam.Role(this, 'SchedulerStartEc2Role', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description:
        'Allows EventBridge Scheduler to call ec2:StartInstances for the managed instance',
    });
    startRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances'],
        resources: [instanceArn],
      }),
    );

    const stopRole = new iam.Role(this, 'SchedulerStopEc2Role', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description:
        'Allows EventBridge Scheduler to call ec2:StopInstances for the managed instance',
    });
    stopRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StopInstances'],
        resources: [instanceArn],
      }),
    );

    new scheduler.CfnSchedule(this, 'StartSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: props.scheduleStartCron,
      scheduleExpressionTimezone,
      target: {
        arn: startTargetArn,
        roleArn: startRole.roleArn,
        input: ec2Payload,
      },
    });

    new scheduler.CfnSchedule(this, 'StopSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: props.scheduleStopCron,
      scheduleExpressionTimezone,
      target: {
        arn: stopTargetArn,
        roleArn: stopRole.roleArn,
        input: ec2Payload,
      },
    });
  }
}
