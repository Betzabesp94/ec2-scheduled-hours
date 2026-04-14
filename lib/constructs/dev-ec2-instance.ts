import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DevEc2InstanceProps {
  instanceType: string;
  /**
   * AMI id or CloudFormation dynamic reference, e.g.
   * {{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64:1}}
   */
  machineImage: string;
  rootVolumeSizeGiB: number;
  dataVolumeSizeGiB: number; // 0 disables
  deleteEbsOnTermination: boolean;
  assignPublicIp: boolean;
  mountDataVolume: boolean;
  enableHibernation: boolean;
}

export class DevEc2Instance extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly instanceRole: iam.Role;
  public readonly instance: ec2.CfnInstance;

  constructor(scope: Construct, id: string, props: DevEc2InstanceProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Endpoints to allow SSM access without public IP/NAT.
    const endpointSg = new ec2.SecurityGroup(this, 'VpcEndpointsSg', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Security group for VPC interface endpoints',
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443));

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const interfaceServices: ec2.InterfaceVpcEndpointAwsService[] = [
      ec2.InterfaceVpcEndpointAwsService.SSM,
      ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    ];

    for (const svc of interfaceServices) {
      this.vpc.addInterfaceEndpoint(`Endpoint${svc.shortName}`, {
        service: svc,
        privateDnsEnabled: true,
        securityGroups: [endpointSg],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
    }

    this.securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Basic SG: no inbound by default',
    });

    this.instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Instance role for SSM Session Manager access',
    });
    this.instanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [this.instanceRole.roleName],
    });

    const dataDeviceName = '/dev/xvdb';

    const subnetSelection: ec2.SubnetSelection = props.assignPublicIp
      ? { subnetType: ec2.SubnetType.PUBLIC }
      : { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    const subnetId = this.vpc.selectSubnets(subnetSelection).subnetIds[0];

    const userData = ec2.UserData.forLinux();
    if (props.dataVolumeSizeGiB > 0 && props.mountDataVolume) {
      userData.addCommands(
        'set -euxo pipefail',
        'MOUNT_POINT=/workspace',
        `DEVICE=${dataDeviceName}`,
        'if ! lsblk | grep -q "$(basename $DEVICE)"; then echo "Data device not found: $DEVICE" >&2; exit 1; fi',
        'mkdir -p $MOUNT_POINT',
        // Only format if it looks unformatted
        'if ! blkid $DEVICE; then mkfs -t ext4 $DEVICE; fi',
        'UUID=$(blkid -s UUID -o value $DEVICE)',
        'grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab',
        'mount -a',
        'chown ec2-user:ec2-user $MOUNT_POINT || true',
      );
    }

    const blockDeviceMappings: ec2.CfnInstance.BlockDeviceMappingProperty[] = [
      {
        deviceName: '/dev/xvda',
        ebs: {
          volumeSize: props.rootVolumeSizeGiB,
          volumeType: 'gp3',
          deleteOnTermination: props.deleteEbsOnTermination,
        },
      },
    ];

    if (props.dataVolumeSizeGiB > 0) {
      blockDeviceMappings.push({
        deviceName: dataDeviceName,
        ebs: {
          volumeSize: props.dataVolumeSizeGiB,
          volumeType: 'gp3',
          deleteOnTermination: props.deleteEbsOnTermination,
        },
      });
    }

    this.instance = new ec2.CfnInstance(this, 'Instance', {
      imageId: props.machineImage,
      instanceType: props.instanceType,
      iamInstanceProfile: instanceProfile.ref,
      hibernationOptions: props.enableHibernation ? { configured: true } : undefined,
      metadataOptions: {
        httpTokens: 'required',
      },
      blockDeviceMappings,
      networkInterfaces: [
        {
          deviceIndex: '0',
          subnetId,
          groupSet: [this.securityGroup.securityGroupId],
          associatePublicIpAddress: props.assignPublicIp,
        },
      ],
      userData: cdk.Fn.base64(userData.render()),
      tags: [
        { key: 'Name', value: cdk.Stack.of(this).stackName },
      ],
    });
  }
}

