FROM rabbitmq:4.1.4-management-alpine

# The MQTT listener is optional at the Compose profile level, but once the
# profile is selected this plugin must be available before the broker starts.
RUN rabbitmq-plugins enable --offline rabbitmq_mqtt

COPY rabbitmq.conf /etc/rabbitmq/rabbitmq.conf
