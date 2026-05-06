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
  /**
   * Asignar IP pública a la instancia para conectividad a internet.
   * IMPORTANTE: Si se establece en true:
   * - La instancia se desplegará en una subred PÚBLICA con Internet Gateway
   * - Se asignará una IP pública DINÁMICA automáticamente
   * - La IP pública cambiará cada vez que la instancia se detenga/inicie
   * - Para una IP fija, considerar usar Elastic IP (genera costo adicional si la instancia está detenida)
   * 
   * Si se establece en false:
   * - La instancia se desplegará en una subred AISLADA sin acceso a internet directo
   * - Solo tendrá acceso a servicios AWS vía VPC endpoints
   * 
   * Puede ser un booleano o un string de CloudFormation parameter.
   */
  assignPublicIp: boolean | string;
  mountDataVolume: boolean;
  enableHibernation: boolean;
}

/**
 * DevEc2Instance - Instancia EC2 con configuración flexible de red
 * 
 * CONECTIVIDAD A INTERNET:
 * Para que la instancia tenga acceso a internet, asegúrate de pasar:
 *   assignPublicIp: true
 * 
 * Esto configurará automáticamente:
 * ✓ Subred PÚBLICA con Internet Gateway
 * ✓ Asignación de IP pública dinámica
 * ✓ Security Group con egress permitido a 0.0.0.0/0
 * ✓ Acceso completo para descargar desde repositorios externos (NVIDIA, apt, yum, etc.)
 * 
 * ARQUITECTURA DE RED:
 * - VPC con subredes públicas (con IGW) y aisladas (sin internet)
 * - VPC Endpoints para SSM, CloudWatch, S3 (acceso sin necesidad de internet)
 * - Sin NAT Gateway para reducir costos
 */
export class DevEc2Instance extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly instanceRole: iam.Role;
  public readonly instance: ec2.CfnInstance;

  constructor(scope: Construct, id: string, props: DevEc2InstanceProps) {
    super(scope, id);

    // VPC con subredes públicas y aisladas
    // Las subredes PUBLIC incluyen automáticamente un Internet Gateway
    // que permite el tráfico saliente/entrante a internet
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0, // Sin NAT Gateway para ahorrar costos
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC, // Internet Gateway incluido automáticamente
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // Sin acceso a internet directo
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

    const s3Endpoint = this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    s3Endpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const interfaceServices: ec2.InterfaceVpcEndpointAwsService[] = [
      ec2.InterfaceVpcEndpointAwsService.SSM,
      ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    ];

    for (const svc of interfaceServices) {
      const ep = this.vpc.addInterfaceEndpoint(`Endpoint${svc.shortName}`, {
        service: svc,
        privateDnsEnabled: true,
        securityGroups: [endpointSg],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
      ep.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    // Security Group de la instancia
    // allowAllOutbound: true permite tráfico de salida a 0.0.0.0/0 (necesario para descargas de NVIDIA, apt, yum, etc.)
    this.securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc: this.vpc,
      allowAllOutbound: true, // Permite todo el tráfico egress hacia internet
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

    // SELECCIÓN DE SUBRED: determina si la instancia tiene acceso a internet
    // - PUBLIC: Instancia en subred pública con Internet Gateway, requiere IP pública asignada
    // - PRIVATE_ISOLATED: Sin acceso directo a internet, solo via VPC endpoints
    //
    // Preparar ambos tipos de subredes
    const publicSubnetIds = this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds;
    const isolatedSubnetIds = this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds;

    // Determinar el subnetId según si assignPublicIp es un valor fijo o un parámetro CloudFormation
    let subnetId: string;
    let assignPublicIpValue: boolean | string;
    let assignPublicIpCondition: cdk.CfnCondition | undefined;

    if (typeof props.assignPublicIp === 'boolean') {
      // Valor fijo: seleccionar en tiempo de síntesis
      subnetId = props.assignPublicIp ? publicSubnetIds[0] : isolatedSubnetIds[0];
      assignPublicIpValue = props.assignPublicIp;
    } else {
      // Es un string (token de CloudFormation): crear condición y seleccionar en runtime
      assignPublicIpCondition = new cdk.CfnCondition(this, 'AssignPublicIpCondition', {
        expression: cdk.Fn.conditionEquals(props.assignPublicIp, 'true'),
      });
      subnetId = cdk.Fn.conditionIf(
        assignPublicIpCondition.logicalId,
        publicSubnetIds[0],
        isolatedSubnetIds[0],
      ).toString();
      assignPublicIpValue = props.assignPublicIp;
    }

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
          deleteOnTermination: true,
        },
      },
    ];

    if (props.dataVolumeSizeGiB > 0) {
      blockDeviceMappings.push({
        deviceName: dataDeviceName,
        ebs: {
          volumeSize: props.dataVolumeSizeGiB,
          volumeType: 'gp3',
          deleteOnTermination: true,
        },
      });
    }

    // ⚠️ ADVERTENCIA IMPORTANTE SOBRE IP PÚBLICA:
    // 
    // La configuración actual usa IP PÚBLICA DINÁMICA (associatePublicIpAddress: true)
    // 
    // IMPLICACIONES:
    // - Cada vez que la instancia se DETIENE y se REINICIA, la IP pública CAMBIARÁ
    // - Esto es normal y permite ahorrar costos al no tener Elastic IP
    // - Si necesitas una IP FIJA que no cambie, considera usar Elastic IP:
    //   * Ventaja: IP permanente incluso si detienes/inicias la instancia
    //   * Desventaja: AWS cobra ~$0.005/hora (~$3.60/mes) cuando la instancia está DETENIDA
    //   * La Elastic IP es GRATIS mientras la instancia esté CORRIENDO
    // 
    // Para añadir Elastic IP (opcional):
    // const eip = new ec2.CfnEIP(this, 'ElasticIP', { domain: 'vpc' });
    // new ec2.CfnEIPAssociation(this, 'EIPAssoc', {
    //   eip: eip.ref,
    //   instanceId: this.instance.ref,
    // });
    //
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
          // CRÍTICO: associatePublicIpAddress debe ser true para conectividad a internet en subred pública
          // Si assignPublicIpValue es un string (token), se resuelve en CloudFormation deployment time
          associatePublicIpAddress: typeof assignPublicIpValue === 'boolean' 
            ? assignPublicIpValue 
            : assignPublicIpCondition 
              ? cdk.Fn.conditionIf(
                  assignPublicIpCondition.logicalId,
                  true,
                  false,
                ) as any
              : false,
        },
      ],
      userData: cdk.Fn.base64(userData.render()),
      tags: [
        { key: 'Name', value: cdk.Stack.of(this).stackName },
      ],
    });

    // Enforce ephemeral stack: ensure CloudFormation deletes every resource it can.
    for (const child of this.node.findAll()) {
      if (child instanceof cdk.CfnResource) {
        child.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      }
    }
  }
}

