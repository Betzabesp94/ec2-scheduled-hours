import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Ec2ScheduledHoursStack } from '../lib/ec2-scheduled-hours-stack';

test('EC2 instance and schedules created', () => {
  const app = new cdk.App({
    context: {
      // keep defaults
    },
  });

  const stack = new Ec2ScheduledHoursStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.resourceCountIs('AWS::Scheduler::Schedule', 2);
});
