# EC2 Scheduled Hours (AWS CDK - TypeScript)

Infraestructura para una **instancia EC2 orientada a entornos de desarrollo/pruebas** con **control de costos** mediante **encendido/apagado automático** vía **EventBridge Scheduler** invocando las APIs de EC2 **StartInstances** y **StopInstances** (targets universales, sin funciones intermedias), y **acceso seguro por SSM Session Manager** (sin llaves SSH por defecto).

## Qué despliega

- **EC2 (EBS-backed)**:
  - `instanceType` configurable (default: `t2.micro`)
  - `machineImage` configurable (default: `AL2023`)
  - Root volume **gp3** (default: **20 GiB**; mínimo configurable **8 GiB**)
  - Segundo volumen de datos opcional **gp3** (default: **0** = deshabilitado; indica tamaño en GiB si lo activas)
  - Los volúmenes EBS (root y data si aplica) se **eliminan** al terminar la instancia (stack efímero)
  - Security Group **sin ingress** por defecto (solo egress)
  - **Sin IP pública** por defecto (configurable)
- **SSM Session Manager**:
  - Rol IAM en la instancia con `AmazonSSMManagedInstanceCore`
  - Conectividad a SSM **sin NAT** usando **VPC Endpoints** (SSM/EC2Messages/SSMMessages/Logs + S3 Gateway)
- **Automatización Start/Stop**:
  - 2 schedules de **EventBridge Scheduler** con expresiones **cron** parametrizables (`ScheduleStartCron` / `ScheduleStopCron`)
  - Zona horaria por defecto del scheduler: **`America/Argentina/Buenos_Aires`** (ver `lib/constructs/ec2-start-stop-scheduler.ts`)
  - Cada schedule usa un **target universal** hacia el SDK de EC2 (`startInstances` / `stopInstances`) con payload JSON `{"InstanceIds":["<id>"]}` (ID de la instancia creada por el stack, referencia de CloudFormation)
  - 2 roles IAM asumidos por `scheduler.amazonaws.com`, con permisos mínimos: `ec2:StartInstances` o `ec2:StopInstances` solo sobre el ARN de esa instancia

## Cron por defecto (qué significa)

Las expresiones usan el formato de **EventBridge Scheduler** (`cron(minuto hora día-mes mes día-semana año)`).

| Parámetro           | Valor por defecto          | Significado (con la timezone del scheduler) |
| ------------------- | -------------------------- | ------------------------------------------- |
| `ScheduleStartCron` | `cron(0 9 ? * MON-FRI *)`  | Encender **lunes a viernes a las 09:00**    |
| `ScheduleStopCron`  | `cron(0 19 ? * MON-FRI *)` | Apagar **lunes a viernes a las 19:00**      |

Para otra zona horaria, amplía el construct `Ec2StartStopScheduler` para pasar `scheduleExpressionTimezone` o cámbialo en código.

- **Outputs**:
  - Instance ID
  - Comando sugerido para conectarse por Session Manager

## Requisitos

- Node.js + npm
- AWS credentials configuradas (por ejemplo via `aws configure` / SSO)
- Bootstrap del CDK en tu cuenta/región (si aplica)

## Comandos

```bash
npm install
npx cdk synth
npx cdk deploy
```

## Configuración (contexto o parámetros)

Puedes configurar vía:

- **Contexto CDK**: `npx cdk deploy -c key=value`
- **Parámetros de CloudFormation**: `npx cdk deploy --parameters Key=Value`

Parámetros soportados (con defaults):

- `InstanceType` (default `t2.micro`)
- `MachineImage` (default: dynamic reference a la AMI de Amazon Linux 2023 vía SSM public parameter). Puedes pasar un **AMI ID** (ej. `ami-...`) o un **dynamic reference** `{{resolve:ssm:...:1}}`.
- `RootVolumeSize` (default `20`)
- `DataVolumeSize` (default `0`; indica GiB del volumen de datos; mayor que `0` lo crea y opcionalmente lo monta)
- `AssignPublicIp` (default `false`)
- `MountDataVolume` (default `true`)
- `EnableHibernation` (default `false`)
- `ScheduleStartCron` (default `cron(0 9 ? * MON-FRI *)`)
- `ScheduleStopCron` (default `cron(0 19 ? * MON-FRI *)`)
- `Project` (default `ec2-scheduled-hours`)
- `Environment` (default `dev`)

Ejemplo con contexto:

```bash
npx cdk deploy \
  -c environment=dev \
  -c instanceType=t3.large \
  -c machineImage="{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64:1}}" \
  -c rootVolumeSize=60 \
  -c dataVolumeSize=200 \
  -c assignPublicIp=false \
  -c scheduleStartCron="cron(0 8 ? * MON-FRI *)" \
  -c scheduleStopCron="cron(0 20 ? * MON-FRI *)"
```

## Conexión por Session Manager

Tras desplegar, usa el output `SsmStartSessionCommand` o:

```bash
aws ssm start-session --target <INSTANCE_ID> --region <REGION>
```
