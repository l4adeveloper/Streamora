BEGIN;
ALTER TABLE "class_session_commands" DROP CONSTRAINT "class_session_commands_operation_check";
ALTER TABLE "class_session_commands" ADD CONSTRAINT "class_session_commands_operation_check"
  CHECK ("operation" IN ('CREATE_GROUP', 'CREATE_MEET', 'START', 'END', 'CANCEL', 'REQUEST_JOIN', 'ENTER_SESSION'));
COMMIT;
