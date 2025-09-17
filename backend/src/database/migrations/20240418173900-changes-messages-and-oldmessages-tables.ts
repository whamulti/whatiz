import { QueryInterface, DataTypes } from "sequelize";

export default {
  up: async (queryInterface: QueryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeConstraint(
        "Messages",
        "Messages_quotedMsgId_fkey",
        { transaction }
      );
      await queryInterface.removeConstraint(
        "OldMessages",
        "OldMessages_messageId_fkey",
        { transaction }
      );
      await queryInterface.removeConstraint("Messages", "Messages_pkey", {
        transaction
      });
      await queryInterface.addConstraint("Messages", {
        fields: ["id", "ticketId"],
        type: "primary key",
        name: "Messges_id_ticketId_pk",
        transaction
      });
      await queryInterface.addColumn(
        "OldMessages",
        "ticketId",
        {
          type: DataTypes.INTEGER,
          references: { model: "Tickets", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL"
        },
        { transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface: QueryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn("OldMessages", "ticketId", {
        transaction
      });
      await queryInterface.removeConstraint(
        "Messages",
        "Messges_id_ticketId_pk",
        { transaction }
      );
      await queryInterface.addConstraint("Messages", {
        fields: ["id"],
        type: "primary key",
        name: "Messages_pkey",
        transaction
      });
      await queryInterface.addConstraint("OldMessages", {
        fields: ["messageId"],
        type: "foreign key",
        name: "OldMessages_messageId_fkey",
        references: {
          table: "Messages",
          field: "id"
        },
        onDelete: "CASCADE",
        onUpdate: "CASCADE",
        transaction
      });
      await queryInterface.addConstraint("Messages", {
        fields: ["quotedMsgId"],
        type: "foreign key",
        name: "Messages_quotedMsgId_fkey",
        references: {
          table: "Messages",
          field: "id"
        },
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
        transaction
      });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
