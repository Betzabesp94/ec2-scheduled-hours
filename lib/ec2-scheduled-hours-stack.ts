import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { DevEc2Instance } from "./constructs/dev-ec2-instance";
import { Ec2StartStopScheduler } from "./constructs/ec2-start-stop-scheduler";

export class Ec2ScheduledHoursStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const project = new cdk.CfnParameter(this, "Project", {
      type: "String",
      default: this.node.tryGetContext("project") ?? "ec2-scheduled-hours",
    });

    const environment = new cdk.CfnParameter(this, "Environment", {
      type: "String",
      default: this.node.tryGetContext("environment") ?? "dev",
    });

    cdk.Tags.of(this).add("Project", project.valueAsString);
    cdk.Tags.of(this).add("Environment", environment.valueAsString);

    const instanceType = new cdk.CfnParameter(this, "InstanceType", {
      type: "String",
      default: this.node.tryGetContext("instanceType") ?? "t2.micro",
      description: "EC2 instance type, e.g. t2.micro",
    });

    const machineImage = new cdk.CfnParameter(this, "MachineImage", {
      type: "String",
      default:
        this.node.tryGetContext("machineImage") ??
        "{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64:1}}",
      description:
        "AMI id or CloudFormation dynamic reference (default uses SSM public parameter for Amazon Linux 2023)",
    });

    const rootVolumeSize = new cdk.CfnParameter(this, "RootVolumeSize", {
      type: "Number",
      default: Number(this.node.tryGetContext("rootVolumeSize") ?? 50),
      description: "Root EBS volume size in GiB",
      minValue: 8,
    });

    const dataVolumeSize = new cdk.CfnParameter(this, "DataVolumeSize", {
      type: "Number",
      default: Number(this.node.tryGetContext("dataVolumeSize") ?? 0),
      description: "Optional data EBS volume size in GiB (set 0 to disable)",
      minValue: 0,
    });

    const assignPublicIp = new cdk.CfnParameter(this, "AssignPublicIp", {
      type: "String",
      allowedValues: ["true", "false"],
      default: String(this.node.tryGetContext("assignPublicIp") ?? "false"),
      description: "Assign a public IP to the instance (default false)",
    });

    const scheduleStartCron = new cdk.CfnParameter(this, "ScheduleStartCron", {
      type: "String",
      default:
        this.node.tryGetContext("scheduleStartCron") ??
        "cron(0 9 ? * MON-FRI *)",
      description:
        "EventBridge Scheduler cron expression for starting the instance",
    });

    const scheduleStopCron = new cdk.CfnParameter(this, "ScheduleStopCron", {
      type: "String",
      default:
        this.node.tryGetContext("scheduleStopCron") ??
        "cron(0 19 ? * MON-FRI *)",
      description:
        "EventBridge Scheduler cron expression for stopping the instance",
    });

    const mountDataVolume = new cdk.CfnParameter(this, "MountDataVolume", {
      type: "String",
      allowedValues: ["true", "false"],
      default: String(this.node.tryGetContext("mountDataVolume") ?? "true"),
      description:
        "If true, user data will format+mount the data volume at /workspace",
    });

    const enableHibernation = new cdk.CfnParameter(this, "EnableHibernation", {
      type: "String",
      allowedValues: ["true", "false"],
      default: String(this.node.tryGetContext("enableHibernation") ?? "false"),
      description:
        "Enable EC2 hibernation (requires supported instance types / constraints)",
    });

    const ec2 = new DevEc2Instance(this, "DevInstance", {
      instanceType: instanceType.valueAsString,
      machineImage: machineImage.valueAsString,
      rootVolumeSizeGiB: rootVolumeSize.valueAsNumber,
      dataVolumeSizeGiB: dataVolumeSize.valueAsNumber,
      assignPublicIp: assignPublicIp.valueAsString === "true",
      mountDataVolume: mountDataVolume.valueAsString === "true",
      enableHibernation: enableHibernation.valueAsString === "true",
    });

    new Ec2StartStopScheduler(this, "StartStopScheduler", {
      instanceId: ec2.instance.ref,
      scheduleStartCron: scheduleStartCron.valueAsString,
      scheduleStopCron: scheduleStopCron.valueAsString,
    });

    new cdk.CfnOutput(this, "InstanceId", {
      value: ec2.instance.ref,
    });

    new cdk.CfnOutput(this, "SsmStartSessionCommand", {
      value: `aws ssm start-session --target ${ec2.instance.ref} --region ${cdk.Stack.of(this).region}`,
    });
  }
}
